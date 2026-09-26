export default async function handler(request, response) {
  const { default: handleMeteora } = await import("../apps/web/api/meteora.js");
  return handleMeteora(request, response);
}
