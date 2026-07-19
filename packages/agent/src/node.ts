export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
export * from "./index.ts";
// Node-only §5.5 identity resolver for the dag-v2 scheduler (fs/realpath/inode).
export {
	createNodeResourceKeyResolver,
	type NodeResourceKeyResolverOptions,
} from "./node-resource-resolver.ts";
