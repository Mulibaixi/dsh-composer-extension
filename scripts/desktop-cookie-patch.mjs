/** Keep the official Desktop bundle intact except for the loopback authentication-cookie cleanup. */
export function patchDesktopMain(bytes) {
  const source = bytes.toString('utf8')
  const anchor = '\t\t\t\thostCookie = await authenticateWebHost(ready.url);\n\t\t\t\thostUrl = ready.url;'
  if (source.split(anchor).length !== 2) throw new Error('Official Desktop authentication anchor is missing or ambiguous.')
  const cleanup = [
    '\t\t\t\tconst currentCookieName = hostCookie.slice(0, hostCookie.indexOf("="));',
    '\t\t\t\tconst cookieUrl = new URL(ready.url);',
    '\t\t\t\tif (cookieUrl.hostname === "127.0.0.1") {',
    '\t\t\t\t\tfor (const cookie of await session.defaultSession.cookies.get({ url: cookieUrl.href })) {',
    '\t\t\t\t\t\tif (cookie.domain === "127.0.0.1" && cookie.path === "/" && cookie.name.startsWith("dsh-auth-") && cookie.name !== currentCookieName) {',
    '\t\t\t\t\t\t\tawait session.defaultSession.cookies.remove(cookieUrl.origin + "/", cookie.name);',
    '\t\t\t\t\t\t}',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
  ].join('\n')
  return Buffer.from(source.replace(anchor, '\t\t\t\thostCookie = await authenticateWebHost(ready.url);\n' + cleanup + '\n\t\t\t\thostUrl = ready.url;'))
}
