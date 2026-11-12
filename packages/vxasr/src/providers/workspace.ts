/**
 * DashScope workspace ids, for the providers whose endpoint is
 * `<WorkspaceId>.<region>.maas.aliyuncs.com`.
 *
 * The id becomes a **hostname label**, and the bearer key is sent to that host,
 * so it is checked rather than trusted: a value like `x.evil.com/#` would
 * otherwise hand the key to another host. A DNS label is letters, digits and
 * hyphens.
 */
export function isValidWorkspaceId(id: string | undefined): id is string {
  return !!id && /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(id);
}

/**
 * Strip the workspace id from a message that will reach a client. A transport
 * failure names the host it could not reach (`getaddrinfo ENOTFOUND
 * <id>.ap-southeast-1…`), and the id is part of the account's address.
 */
export function redactWorkspaceId(message: string, workspaceId: string | undefined): string {
  return workspaceId ? message.split(workspaceId).join("<workspace>") : message;
}
