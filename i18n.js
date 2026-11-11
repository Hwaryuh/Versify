export const t = (key, ...subs) => globalThis.chrome?.i18n?.getMessage(key, subs.map(String)) || key;
