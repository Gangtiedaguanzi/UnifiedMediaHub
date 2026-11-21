// Node 22 reviver context retains the original numeric token before IEEE rounding.
// Framework state has no such token and unsafe numeric IDs must still be rejected.
export function parseLossless(text) {
  return JSON.parse(text, (_key, value, context) => {
    if(typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if(!/^-?\d+$/.test(context?.source ?? ''))throw new Error('unsafe_numeric_token');
      return context.source;
    }
    return value;
  });
}
