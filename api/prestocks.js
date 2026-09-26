export default async function handler(request, response) {
  const { default: handlePreStocks } = await import("../apps/web/api/prestocks.js");
  return handlePreStocks(request, response);
}
