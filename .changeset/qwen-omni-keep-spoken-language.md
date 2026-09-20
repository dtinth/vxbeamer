---
"vxasr": patch
---

Stop the Qwen Omni instruction translating English into Thai. The previous wording stated its Thai script rule unconditionally, which reads as a claim about the output rather than a rule about Thai — English audio came back translated in 10 runs out of 10. The instruction now names the spoken language explicitly and applies the Thai rule only when Thai is spoken, which takes that to 0 out of 10 while keeping the tag and spacing fixes intact.
