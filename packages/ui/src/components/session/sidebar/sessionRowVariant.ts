import React from 'react';

/**
 * How a session row lays itself out.
 *
 * - `default`: the workspace row.
 * - `card`: the by-folder and timeline row. The title leads, the timestamp
 *   sits on the title line, and folder/branch/PR details form a smaller,
 *   quieter second line so a row reads as one unit under its heading.
 */
type SessionRowVariant = 'default' | 'card';

export const SessionRowVariantContext = React.createContext<SessionRowVariant>('default');
