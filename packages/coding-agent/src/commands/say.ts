/**
 * Synthesize text with the local TTS engine and play it (or save it with --out).
 *
 * Demonstrates the on-device speech stack end to end: the first run downloads
 * the configured local model, synthesis happens in the TTS worker subprocess,
 * and the resulting WAV is either played through the speakers or written to disk.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, Snowflake } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "chalk";
import { Settings, settings } from "../config/settings";
import { playAudioFile, removeTempFile } from "../tts/player";
import { shutdownTtsClient, ttsClient } from "../tts/tts-client";
import { encodeWav } from "../tts/wav";

export default class Say extends Command {
	static description = "Synthesize text with the local TTS engine and play it through the speakers";

	static args = {
		text: Args.string({ required: true, description: "Text to speak" }),
	};

	static flags = {
		voice: Flags.string({ description: "Voice id" }),
		model: Flags.string({ description: "Local TTS model key" }),
		out: Flags.string({ char: "o", description: "Write WAV to this path instead of playing" }),
	};

	static examples = [
		'omp say "hello world"',
		'omp say "hello world" --out /tmp/hello.wav',
		'omp say "bonjour" --voice af_heart --model kokoro',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Say);
		const text = args.text ?? "";

		await Settings.init({ cwd: getProjectDir() });
		const model = flags.model ?? settings.get("tts.localModel");
		const voice = flags.voice ?? settings.get("tts.localVoice");

		let exitCode = 0;
		const unsubscribe = ttsClient.onProgress(event => {
			if (event.status === "progress" && typeof event.progress === "number") {
				process.stderr.write(
					`\r${chalk.dim(`downloading ${event.file ?? model}: ${Math.round(event.progress)}%`)}`,
				);
			} else if (event.status === "done" || event.status === "ready") {
				// Clear the progress line once the download finishes.
				process.stderr.write("\r\x1b[K");
			}
		});

		try {
			const audio = await ttsClient.synthesize(model, text, { voice });
			if (!audio) {
				process.stderr.write(
					chalk.red(
						`error: could not synthesize with local TTS model "${model}". ` +
							"Run `omp setup speech` to install it.\n",
					),
				);
				exitCode = 1;
				return;
			}

			const wav = encodeWav(audio.pcm, audio.sampleRate);
			const durationSec = audio.pcm.length / audio.sampleRate;

			if (flags.out) {
				await Bun.write(flags.out, wav);
				process.stdout.write(
					`${chalk.green("saved")} ${flags.out} ` +
						`${chalk.dim(`(${voice}, ${model}, ${durationSec.toFixed(1)}s, ${wav.byteLength} bytes)`)}\n`,
				);
				return;
			}

			const tmp = path.join(os.tmpdir(), `omp-say-${Snowflake.next()}.wav`);
			await Bun.write(tmp, wav);
			try {
				await playAudioFile(tmp);
				process.stdout.write(
					`${chalk.green("spoke")} ${chalk.dim(`(${voice}, ${model}, ${durationSec.toFixed(1)}s)`)}\n`,
				);
			} finally {
				await removeTempFile(tmp);
			}
		} catch (err) {
			process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
			exitCode = 1;
		} finally {
			unsubscribe();
			await shutdownTtsClient();
		}

		if (exitCode !== 0) process.exit(exitCode);
	}
}
