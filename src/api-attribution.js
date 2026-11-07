export function clientKeyAttribution(clientKey, apiProtocol) {
  return {
    apiProtocol,
    clientKeyId: String(clientKey?.id || ''),
    clientKeyName: String(clientKey?.name || ''),
  };
}

export function withClientKeyAttribution(result, clientKey, apiProtocol) {
  const value = result && typeof result === 'object' ? result : {};
  return {
    ...value,
    meta: {
      ...(value.meta && typeof value.meta === 'object' ? value.meta : {}),
      ...clientKeyAttribution(clientKey, apiProtocol),
    },
  };
}
