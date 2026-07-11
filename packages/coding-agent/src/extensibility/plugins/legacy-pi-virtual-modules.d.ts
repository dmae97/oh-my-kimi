declare module "omp-legacy-pi-modules" {
	/** Host package namespaces retained by the compiled binary for legacy extensions. */
	export const BUNDLED_PI_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
