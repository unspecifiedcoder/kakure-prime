export default async function handler(request, response) {
  const { default: handleProtocol } = await import("../apps/web/api/protocol.js");
  return handleProtocol(request, response);
}
