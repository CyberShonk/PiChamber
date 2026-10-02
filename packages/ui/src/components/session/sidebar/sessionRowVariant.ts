import React from 'react';

/**
 * How a session row lays itself out.
 *
 * - `default`: the workspace row.
 * - `card`: the timeline row. The title leads, the timestamp sits on the
 *   title line, and folder/branch/PR details form a smaller, quieter second
 *   line so a row reads as one unit under its heading.
 * - `tree`: the by-folder row. A card whose row chrome spans the full sidebar
 *   width while its content starts under the folder label; the leading gutter
 *   that produces the indent carries the working indicator.
 */
type SessionRowVariant = 'default' | 'card' | 'tree';

export const SessionRowVariantContext = React.createContext<SessionRowVariant>('default');
