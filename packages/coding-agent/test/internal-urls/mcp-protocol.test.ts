import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../../src/internal-urls";
import { MCPManager } from "../../src/mcp/manager";
import type { MCPResource, MCPResourceReadResult, MCPResourceTemplate } from "../../src/mcp/types";

function createMockManager(opts: {
	servers?: string[];
	resources?: Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>;
	readResult?: MCPResourceReadResult | undefined;
	readError?: Error;
}) {
	return {
		getConnectedServers: () => opts.servers ?? [],
		getServerResources: (name: string) => opts.resources?.get(name),
		readServerResource: async (_name: string, _uri: string) => {
			if (opts.readError) throw opts.readError;
			return opts.readResult;
		},
	} as unknown as MCPManager;
}

describe("McpProtocolHandler", () => {
	beforeEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		MCPManager.resetForTests();
		InternalUrlRouter.resetForTests();
	});

	it("returns error when no MCP manager is available", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("mcp://test://resource")).rejects.toThrow("No MCP manager");
	});

	it("requires resource URI in mcp URL", async () => {
		const manager = createMockManager({ servers: ["server-a"] });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("mcp://")).rejects.toThrow("mcp:// URL requires a resource URI");
	});

	it("returns error listing available resources when no server matches", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("server-a", {
			resources: [{ uri: "file://known", name: "known-resource" }],
			templates: [],
		});
		const manager = createMockManager({ servers: ["server-a"], resources });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("No MCP server has resource");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("file://known");
		await expect(router.resolve("mcp://test://missing")).rejects.toThrow("server-a");
	});

	it("reads resource by exact URI match", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("my-server", {
			resources: [{ uri: "test://doc", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["my-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc", text: "hello world" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://doc");
		expect(resource.content).toBe("hello world");
		expect(resource.notes).toEqual(["MCP server: my-server"]);
	});

	it("preserves query parameters in MCP resource URI", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-server", {
			resources: [{ uri: "test://doc?q=1", name: "doc" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["query-server"],
			resources,
			readResult: { contents: [{ uri: "test://doc?q=1", text: "query resource" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://doc?q=1");
		expect(resource.content).toBe("query resource");
	});

	it("matches URI templates when no exact URI exists", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs/{id}/raw", name: "doc-template" }],
		});
		const manager = createMockManager({
			servers: ["tmpl-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs/foo/raw", text: "from template" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://docs/foo/raw");
		expect(resource.content).toBe("from template");
	});

	it("matches templates when an expression expands to an empty string", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("query-template-server", {
			resources: [],
			templates: [{ uriTemplate: "test://docs{?cursor}", name: "query-template" }],
		});
		const manager = createMockManager({
			servers: ["query-template-server"],
			resources,
			readResult: { contents: [{ uri: "test://docs", text: "empty expansion" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://docs");
		expect(resource.content).toBe("empty expansion");
	});

	it("picks the most specific matching template across overlapping schemes", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("broad-server", {
			resources: [],
			templates: [{ uriTemplate: "test://{path}", name: "broad" }],
		});
		resources.set("specific-server", {
			resources: [],
			templates: [{ uriTemplate: "test://foo/{id}", name: "specific" }],
		});
		const manager = createMockManager({
			servers: ["broad-server", "specific-server"],
			resources,
			readResult: { contents: [{ uri: "test://foo/123", text: "from specific" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://foo/123");
		expect(resource.notes).toEqual(["MCP server: specific-server"]);
	});

	it("uses connected server order when matching templates are equally specific", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "first-template" }],
		});
		resources.set("second", {
			resources: [],
			templates: [{ uriTemplate: "test://{id}", name: "second-template" }],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://foo", text: "from first" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://foo");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("does not match template with different scheme prefix", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("tmpl-server", {
			resources: [],
			templates: [{ uriTemplate: "testing://{id}", name: "testing-template" }],
		});
		const manager = createMockManager({ servers: ["tmpl-server"], resources });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://foo")).rejects.toThrow("No MCP server has resource");
	});

	it("returns error when readServerResource returns undefined", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("null-server", {
			resources: [{ uri: "test://empty", name: "empty" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["null-server"],
			resources,
			readResult: undefined,
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("returned no content");
		await expect(router.resolve("mcp://test://empty")).rejects.toThrow("null-server");
	});

	it("formats binary content with mime type and base64 length", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("bin-server", {
			resources: [{ uri: "test://image", name: "image" }],
			templates: [],
		});
		const blobData = "iVBORw0KGgo=";
		const manager = createMockManager({
			servers: ["bin-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://image", mimeType: "image/png", blob: blobData }],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://image");
		expect(resource.content).toContain("[Binary content:");
		expect(resource.content).toContain("image/png");
		expect(resource.content).toContain(`base64 length ${blobData.length}`);
	});

	it("joins mixed text and binary content with --- separator", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("mix-server", {
			resources: [{ uri: "test://mixed", name: "mixed" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["mix-server"],
			resources,
			readResult: {
				contents: [
					{ uri: "test://mixed", text: "part one" },
					{ uri: "test://mixed", blob: "AAAA", mimeType: "application/octet-stream" },
				],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://mixed");
		expect(resource.content).toContain("part one");
		expect(resource.content).toContain("\n---\n");
		expect(resource.content).toContain("[Binary content:");
	});

	it("returns (empty resource) when content items have neither text nor blob", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("empty-server", {
			resources: [{ uri: "test://blank", name: "blank" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["empty-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://blank" }],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://blank");
		expect(resource.content).toBe("(empty resource)");
	});

	it("returns error with message when readServerResource throws", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("err-server", {
			resources: [{ uri: "test://fail", name: "fail" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["err-server"],
			resources,
			readError: new Error("connection refused"),
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("MCP resource read error:");
		await expect(router.resolve("mcp://test://fail")).rejects.toThrow("connection refused");
	});

	it("picks the first server with a matching resource", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("first", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		resources.set("second", {
			resources: [{ uri: "test://shared", name: "shared" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["first", "second"],
			resources,
			readResult: { contents: [{ uri: "test://shared", text: "from first" }] },
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://shared");
		expect(resource.notes).toEqual(["MCP server: first"]);
	});

	it("shows (none) when no servers have any resources", async () => {
		const manager = createMockManager({ servers: ["lonely-server"] });
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mcp://test://anything")).rejects.toThrow("(none)");
	});

	it("uses unknown for binary content without mimeType", async () => {
		const resources = new Map<string, { resources: MCPResource[]; templates: MCPResourceTemplate[] }>();
		resources.set("bin-server", {
			resources: [{ uri: "test://bin", name: "bin" }],
			templates: [],
		});
		const manager = createMockManager({
			servers: ["bin-server"],
			resources,
			readResult: {
				contents: [{ uri: "test://bin", blob: "data" }],
			},
		});
		MCPManager.setInstance(manager);
		const router = InternalUrlRouter.instance();

		const resource = await router.resolve("mcp://test://bin");
		expect(resource.content).toContain("[Binary content: unknown,");
	});
});
