/**
 * Entry (entry.ts): boots the foldkit runtime against the application built
 * in main.ts.
 */

import { Runtime } from "foldkit";

import { application } from "./main.ts";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

Runtime.run(application);
