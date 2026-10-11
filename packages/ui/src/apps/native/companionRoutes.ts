/** Keep the visible frame's indices stable while a newer snapshot is queued. */
export const createCompanionRoutes = <T extends {
    owner: {
        id: number;
    };
}>() => {
    const frames = new Map<number, T>();
    let owner = -1;
    return {
        remember(scope: number, value: T) {
            if (owner !== value.owner.id) {
                frames.clear();
                owner = value.owner.id;
            }
            frames.set(scope, value);
            while (frames.size > 32)
                frames.delete(frames.keys().next().value!);
        },
        resolve(scope: number, activeOwner: number) {
            return activeOwner === owner ? frames.get(scope) : undefined;
        },
    };
};
