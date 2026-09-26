export default async function handler(request, response) {
  const { default: handlePyth } = await import("../apps/web/api/pyth.js");
  return handlePyth(request, response);
}
