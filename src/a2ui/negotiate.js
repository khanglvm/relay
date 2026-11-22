// Decides whether a caller can draw the board catalog, from what it declared.
import { A2UI_MIMES, A2UI_PROTOCOL_VERSION, BOARD_CATALOG_ID } from './board-constants.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The a2ui declaration inside client capabilities: top-level, or under `extensions` or `experimental`. */
function declared(capabilities) {
  if (!isObject(capabilities)) return undefined;
  const nested = (key) => (isObject(capabilities[key]) ? capabilities[key].a2ui : undefined);
  return capabilities.a2ui ?? nested('extensions') ?? nested('experimental');
}

/** True when the client declared the board catalog when it connected. */
export const capabilitiesDeclareBoardCatalog = (capabilities) => declaresBoardCatalog(declared(capabilities));

/**
 * True when a declaration lists the board catalog for protocol 1.0:
 * `{"1.0": {supportedCatalogIds: [...]}}`. A declaration that names the MIME
 * types it accepts must include one Relay sends.
 */
export function declaresBoardCatalog(declaration) {
  if (!isObject(declaration)) return false;
  const version = declaration[A2UI_PROTOCOL_VERSION];
  if (!isObject(version) || !Array.isArray(version.supportedCatalogIds)) return false;
  if (!version.supportedCatalogIds.includes(BOARD_CATALOG_ID)) return false;
  const mimes = declaration.mimeTypes ?? version.mimeTypes;
  return !Array.isArray(mimes) || mimes.some((m) => A2UI_MIMES.includes(m));
}

/**
 * Whether a call should get A2UI messages: the call's own `_meta.a2ui` decides first,
 * then the capabilities the client declared when it connected.
 * @param {{ capabilities?: any, meta?: any }} caller
 */
export function wantsA2ui({ capabilities, meta }) {
  if (isObject(meta) && 'a2ui' in meta) return declaresBoardCatalog(meta.a2ui);
  return capabilitiesDeclareBoardCatalog(capabilities);
}
