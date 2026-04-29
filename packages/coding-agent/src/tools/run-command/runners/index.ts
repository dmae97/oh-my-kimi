import type { TaskRunner } from "../runner";
import { cargoRunner } from "./cargo";
import { justRunner } from "./just";
import { makeRunner } from "./make";
import { pkgRunner } from "./pkg";
import { taskRunner } from "./task";

export const RUNNERS: TaskRunner[] = [justRunner, pkgRunner, cargoRunner, makeRunner, taskRunner];
