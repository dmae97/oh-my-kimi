/**
 * Session-bound file snapshot store.
 *
 * Used by `read` and `search` to record exactly what the model saw, and by
 * the hashline patcher to recover from stale section hashes (file changed
 * externally between read and edit, or a prior in-session edit advanced
 * the hash). The store is the {@link InMemorySnapshotStore} implementation
 * from `@oh-my-pi/hashline`; the only coding-agent-specific concern here
 * is wiring it onto the per-session {@link ToolSession} object.
 */
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";
import type { ToolSession } from "../tools";

/**
 * Look up (or lazily create) the file snapshot store attached to a session.
 * Storage lives on `session.fileSnapshotStore` so it ages out exactly with
 * the session itself.
 */
export function getFileSnapshotStore(session: ToolSession): InMemorySnapshotStore {
	if (!session.fileSnapshotStore) session.fileSnapshotStore = new InMemorySnapshotStore();
	return session.fileSnapshotStore;
}
