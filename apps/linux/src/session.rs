//! One recording: mic → `/ws`, transcript ← `/sse`, then the clipboard.
//!
//! Everything that can happen arrives on one channel as an [`Event`], so
//! the main loop is a small state machine rather than a tangle of threads
//! that each need to know about the others.

use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};

use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM, SIGUSR1};
use tungstenite::Message;

use crate::{
    capture,
    config::Config,
    desktop::{self, Notifier, Urgency},
    events::{self, SseDecoder, TranscriptUpdate},
    lock::Lock,
    urls,
};

/// How long to wait for the final transcript once the mic is off.
const FINAL_TIMEOUT: Duration = Duration::from_secs(30);
/// 100 ms of 16 kHz 16-bit mono.
const CHUNK_BYTES: usize = 3200;
const PARTIAL_UPDATE_INTERVAL: Duration = Duration::from_millis(250);
const ICON: &str = "audio-input-microphone";

enum Event {
    Stop,
    Cancel,
    CaptureEnded,
    Transcript(TranscriptUpdate),
    StreamFailed(String),
    SocketFailed(String),
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .is_err()
    {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        buf = (nanos ^ std::process::id() as u128).to_le_bytes()[..bytes.min(16)].to_vec();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn ellipsize_start(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - max_chars).collect();
    format!("…{tail}")
}

pub fn run(mut lock: Lock) -> Result<(), String> {
    let mut notifier = Notifier::default();
    let result = record(&mut lock, &mut notifier);
    lock.release();
    match &result {
        Ok(Some(text)) => {
            let how = desktop::copy_to_clipboard(text);
            println!("{text}");
            match how {
                Ok(how) => {
                    eprintln!("vxbeamer: copied to clipboard via {how}");
                    notifier.show(
                        "Copied transcript",
                        text,
                        "edit-paste",
                        Urgency::Normal,
                        6000,
                    );
                }
                Err(e) => {
                    notifier.show(
                        "Transcribed, but could not copy",
                        text,
                        ICON,
                        Urgency::Normal,
                        15000,
                    );
                    return Err(e);
                }
            }
        }
        Ok(None) => notifier.show("Recording cancelled", "", ICON, Urgency::Low, 2000),
        Err(e) => notifier.show(
            "Transcription failed",
            e,
            "dialog-error",
            Urgency::Critical,
            15000,
        ),
    }
    result.map(|_| ())
}

/// Returns the final transcript, or `None` if cancelled.
fn record(lock: &mut Lock, notifier: &mut Notifier) -> Result<Option<String>, String> {
    let mut config = Config::load()?;
    let access_token = config.current_access_token()?;
    let recorder = capture::recorder(config.record_command.as_ref())?;
    let reference_id = format!("linux-{}", random_hex(8));
    let client_id = random_hex(16);

    let (tx, rx) = mpsc::channel::<Event>();
    watch_signals(tx.clone())?;

    // Events first: the snapshot it opens with would cover a missed update
    // anyway, but there is no reason to rely on that.
    let sse_url = urls::server_sent_events(&config.backend_url, &access_token)
        .ok_or("Invalid backend URL in config")?;
    watch_transcript(sse_url, reference_id.clone(), tx.clone());

    let ws_url = urls::web_socket(
        &config.backend_url,
        &access_token,
        &reference_id,
        &client_id,
        config.configuration.as_deref(),
    )
    .ok_or("Invalid backend URL in config")?;
    let (socket, _) = tungstenite::connect(ws_url.as_str()).map_err(|e| connect_error(&e))?;

    let mut child = Command::new(&recorder[0])
        .args(&recorder[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", recorder[0]))?;
    let stdout = child.stdout.take().ok_or("recorder has no stdout")?;
    eprintln!(
        "vxbeamer: listening ({}), toggle again to stop",
        recorder[0]
    );
    notifier.show(
        "Listening…",
        "Press the shortcut again to stop",
        ICON,
        Urgency::Low,
        0,
    );
    stream_audio(stdout, socket, tx.clone());

    let outcome = drive(&rx, &mut child, lock, notifier);
    stop_child(&mut child);
    outcome
}

fn drive(
    rx: &Receiver<Event>,
    child: &mut Child,
    lock: &mut Lock,
    notifier: &mut Notifier,
) -> Result<Option<String>, String> {
    let mut deadline: Option<Instant> = None;
    let mut latest = String::new();
    let mut last_shown = Instant::now() - PARTIAL_UPDATE_INTERVAL;
    let mut socket_error: Option<String> = None;

    loop {
        let event = match deadline {
            None => rx
                .recv()
                .map_err(|_| "internal channel closed".to_string())?,
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(event) => event,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(socket_error
                        .unwrap_or_else(|| "Timed out waiting for the transcript".into()));
                }
                Err(RecvTimeoutError::Disconnected) => return Err("internal channel closed".into()),
            },
        };
        match event {
            Event::Stop | Event::CaptureEnded => {
                if deadline.is_none() {
                    stop_child(child);
                    lock.release();
                    deadline = Some(Instant::now() + FINAL_TIMEOUT);
                    let body = if latest.is_empty() {
                        "…".to_string()
                    } else {
                        ellipsize_start(&latest, 300)
                    };
                    notifier.show("Transcribing…", &body, ICON, Urgency::Low, 0);
                }
            }
            Event::Cancel => return Ok(None),
            Event::Transcript(TranscriptUpdate::Partial(text)) => {
                latest = text;
                if last_shown.elapsed() >= PARTIAL_UPDATE_INTERVAL {
                    last_shown = Instant::now();
                    let title = if deadline.is_some() {
                        "Transcribing…"
                    } else {
                        "Listening…"
                    };
                    notifier.show(title, &ellipsize_start(&latest, 300), ICON, Urgency::Low, 0);
                }
            }
            Event::Transcript(TranscriptUpdate::Final(text)) => return Ok(Some(text)),
            Event::Transcript(TranscriptUpdate::Failed(error)) => return Err(error),
            Event::StreamFailed(error) => return Err(error),
            Event::SocketFailed(error) => {
                // The transcript (or the reason it failed) normally arrives
                // over /sse just before the socket closes, so give it a
                // moment instead of reporting the less useful socket error.
                socket_error = Some(error);
                stop_child(child);
                lock.release();
                let soon = Instant::now() + Duration::from_secs(3);
                deadline = Some(deadline.map_or(soon, |d| d.min(soon)));
            }
        }
    }
}

/// Never shows the URL: it carries the access token.
fn connect_error(error: &tungstenite::Error) -> String {
    let reason = match error {
        tungstenite::Error::Url(_) | tungstenite::Error::Io(_) => {
            "the backend is unreachable".to_string()
        }
        tungstenite::Error::Http(response) => format!("HTTP {}", response.status()),
        other => other.to_string(),
    };
    format!("Could not connect to the backend: {reason}")
}

fn stop_child(child: &mut Child) {
    if let Ok(None) = child.try_wait() {
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
        let _ = child.wait();
    }
}

fn watch_signals(tx: Sender<Event>) -> Result<(), String> {
    let mut signals = signal_hook::iterator::Signals::new([SIGUSR1, SIGINT, SIGTERM, SIGHUP])
        .map_err(|e| e.to_string())?;
    thread::spawn(move || {
        for signal in signals.forever() {
            let event = if signal == SIGUSR1 {
                Event::Stop
            } else {
                Event::Cancel
            };
            if tx.send(event).is_err() {
                break;
            }
        }
    });
    Ok(())
}

fn watch_transcript(url: String, reference_id: String, tx: Sender<Event>) {
    thread::spawn(move || {
        let response = match ureq::get(&url).call() {
            Ok(response) => response,
            Err(e) => {
                let _ = tx.send(Event::StreamFailed(format!(
                    "Could not watch for the transcript: {}",
                    crate::config::describe_http_error(&e)
                )));
                return;
            }
        };
        let mut decoder = SseDecoder::default();
        for line in BufReader::new(response.into_reader()).lines() {
            let Ok(line) = line else { break };
            if let Some(data) = decoder.push_line(&line)
                && let Some(update) = events::parse(&data, &reference_id)
                && tx.send(Event::Transcript(update)).is_err()
            {
                return;
            }
        }
        let _ = tx.send(Event::StreamFailed(
            "Lost the connection while waiting for the transcript".into(),
        ));
    });
}

type Socket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

fn stream_audio(mut audio: impl Read + Send + 'static, mut socket: Socket, tx: Sender<Event>) {
    thread::spawn(move || {
        let mut buf = vec![0u8; CHUNK_BYTES];
        // A read can end mid-sample; carry the odd byte so frames stay aligned.
        let mut carry: Option<u8> = None;
        loop {
            let n = match audio.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let mut chunk = Vec::with_capacity(n + 1);
            chunk.extend(carry.take());
            chunk.extend_from_slice(&buf[..n]);
            if chunk.len() % 2 == 1 {
                carry = chunk.pop();
            }
            if let Err(e) = socket.send(Message::Binary(chunk.into())) {
                let _ = tx.send(Event::SocketFailed(format!(
                    "Lost the connection to the backend: {e}"
                )));
                return;
            }
        }
        let _ = tx.send(Event::CaptureEnded);
        if let Err(e) = socket.send(Message::text(r#"{"type":"stop"}"#)) {
            let _ = tx.send(Event::SocketFailed(format!(
                "Could not finish the recording: {e}"
            )));
            return;
        }
        // Stay connected until the backend is done: hanging up first would
        // leave it finalising for a client that has already gone.
        loop {
            match socket.read() {
                Ok(Message::Close(frame)) => {
                    if let Some(frame) = frame
                        && u16::from(frame.code) != 1000
                    {
                        let _ = tx.send(Event::SocketFailed(format!(
                            "Backend closed the connection: {} ({})",
                            frame.reason,
                            u16::from(frame.code)
                        )));
                    }
                    let _ = socket.close(None);
                    return;
                }
                Ok(_) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return;
                }
                Err(e) => {
                    let _ = tx.send(Event::SocketFailed(format!(
                        "Lost the connection to the backend: {e}"
                    )));
                    return;
                }
            }
        }
    });
}
