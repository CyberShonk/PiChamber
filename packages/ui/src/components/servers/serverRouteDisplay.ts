import {
  sameServerRoute,
  type ServerListItem,
  type ServerRoute,
} from '@/lib/servers/serverViewModel';

export const serverRouteOptionValue = (route: ServerRoute): string =>
  `${route.kind}::${route.address ?? ''}`;

/**
 * Route shown next to the server name: the active route when it is one of
 * the item's routes, otherwise the first route (a stale or missing active
 * route falls back to the first transport instead of rendering nothing).
 * Null when the server has no routes.
 */
export const resolveDisplayedRoute = (
  item: Pick<ServerListItem, 'routes' | 'activeRoute'>,
): ServerRoute | null => {
  if (item.routes.length === 0) return null;
  const active = item.activeRoute;
  if (active) {
    const match = item.routes.find((route) => sameServerRoute(route, active));
    if (match) return match;
  }
  return item.routes[0] ?? null;
};

/** Map a dropdown value back to its route; null when the value is stale. */
export const selectServerRouteByValue = (
  item: Pick<ServerListItem, 'routes'>,
  value: string,
): ServerRoute | null =>
  item.routes.find((route) => serverRouteOptionValue(route) === value) ?? null;
