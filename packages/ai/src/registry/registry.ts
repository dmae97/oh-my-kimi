import { aimlApiProvider } from "./aimlapi";
import { alibabaCodingPlanProvider } from "./alibaba-coding-plan";
import { amazonBedrockProvider } from "./amazon-bedrock";
import { anthropicProvider } from "./anthropic";
import { cerebrasProvider } from "./cerebras";
import { cloudflareAiGatewayProvider } from "./cloudflare-ai-gateway";
import { cursorProvider } from "./cursor";
import { deepseekProvider } from "./deepseek";
import { firepassProvider } from "./firepass";
import { fireworksProvider } from "./fireworks";
import { githubCopilotProvider } from "./github-copilot";
import { gitlabDuoProvider } from "./gitlab-duo";
import { googleProvider } from "./google";
import { googleAntigravityProvider } from "./google-antigravity";
import { googleGeminiCliProvider } from "./google-gemini-cli";
import { googleVertexProvider } from "./google-vertex";
import { groqProvider } from "./groq";
import { huggingfaceProvider } from "./huggingface";
import { kagiProvider } from "./kagi";
import { kiloProvider } from "./kilo";
import { kimiCodeProvider } from "./kimi-code";
import { litellmProvider } from "./litellm";
import { lmStudioProvider } from "./lm-studio";
import { minimaxProvider } from "./minimax";
import { minimaxCodeProvider } from "./minimax-code";
import { minimaxCodeCnProvider } from "./minimax-code-cn";
import { mistralProvider } from "./mistral";
import { moonshotProvider } from "./moonshot";
import { nanogptProvider } from "./nanogpt";
import { nvidiaProvider } from "./nvidia";
import { ollamaProvider } from "./ollama";
import { ollamaCloudProvider } from "./ollama-cloud";
import { openaiProvider } from "./openai";
import { openaiCodexProvider } from "./openai-codex";
import { openaiCodexDeviceProvider } from "./openai-codex-device";
import { opencodeGoProvider } from "./opencode-go";
import { opencodeZenProvider } from "./opencode-zen";
import { openrouterProvider } from "./openrouter";
import { parallelProvider } from "./parallel";
import { perplexityProvider } from "./perplexity";
import { qianfanProvider } from "./qianfan";
import { qwenPortalProvider } from "./qwen-portal";
import { syntheticProvider } from "./synthetic";
import { tavilyProvider } from "./tavily";
import { togetherProvider } from "./together";
import type { ProviderDefinition } from "./types";
import { veniceProvider } from "./venice";
import { vercelAiGatewayProvider } from "./vercel-ai-gateway";
import { vllmProvider } from "./vllm";
import { waferPassProvider } from "./wafer-pass";
import { waferServerlessProvider } from "./wafer-serverless";
import { xaiProvider } from "./xai";
import { xaiOauthProvider } from "./xai-oauth";
import { xiaomiProvider } from "./xiaomi";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp";
import { zaiProvider } from "./zai";
import { zenmuxProvider } from "./zenmux";
import { zhipuCodingPlanProvider } from "./zhipu-coding-plan";

/**
 * The single per-provider list. Adding a provider = create `./providers/<id>.ts`
 * and add its export here. Every legacy structure (`KnownProvider`/`OAuthProvider`
 * unions, descriptors, env map, login list, refresh/login dispatch, CLI callback
 * maps) is derived from this registry. Order matches the interactive `/login`
 * list for the loginable providers; non-login model providers are appended.
 */
const ALL = [
	openaiCodexProvider,
	anthropicProvider,
	zaiProvider,
	kimiCodeProvider,
	openrouterProvider,
	githubCopilotProvider,
	cursorProvider,
	googleAntigravityProvider,
	googleGeminiCliProvider,
	openaiCodexDeviceProvider,
	xaiOauthProvider,
	gitlabDuoProvider,
	alibabaCodingPlanProvider,
	aimlApiProvider,
	zhipuCodingPlanProvider,
	qwenPortalProvider,
	minimaxCodeProvider,
	minimaxCodeCnProvider,
	xiaomiProvider,
	xiaomiTokenPlanSgpProvider,
	xiaomiTokenPlanAmsProvider,
	xiaomiTokenPlanCnProvider,
	firepassProvider,
	waferPassProvider,
	deepseekProvider,
	moonshotProvider,
	cerebrasProvider,
	fireworksProvider,
	togetherProvider,
	nvidiaProvider,
	huggingfaceProvider,
	perplexityProvider,
	qianfanProvider,
	veniceProvider,
	syntheticProvider,
	nanogptProvider,
	waferServerlessProvider,
	vercelAiGatewayProvider,
	cloudflareAiGatewayProvider,
	litellmProvider,
	kiloProvider,
	zenmuxProvider,
	opencodeZenProvider,
	opencodeGoProvider,
	tavilyProvider,
	kagiProvider,
	parallelProvider,
	ollamaProvider,
	ollamaCloudProvider,
	lmStudioProvider,
	vllmProvider,
	openaiProvider,
	googleProvider,
	googleVertexProvider,
	xaiProvider,
	groqProvider,
	mistralProvider,
	minimaxProvider,
	amazonBedrockProvider,
];

export type RegistryDef = (typeof ALL)[number];
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = ALL;

const BY_ID = new Map<string, ProviderDefinition>(ALL.map(p => [p.id, p] as [string, ProviderDefinition]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID.get(id);
}

/** Chat-model providers (those carrying a `defaultModel`). */
export type KnownProviderId = Extract<RegistryDef, { defaultModel: string }>["id"];
/** Loginable providers (those carrying a `login` flow). */
export type OAuthProviderUnion = Extract<RegistryDef, { login: object }>["id"];
