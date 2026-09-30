// Child-process entry for non-blocking package-manager detection. The server
// spawns this once so the dozens of probe processes are forked from this small
// process instead of the large server process (each fork from the server
// blocks its event loop). Prints the detection details as JSON on stdout.
import { detectPackageManagerDetails } from './package-manager.js';

const invokedPath = process.env.PICHAMBER_DETECT_INVOKED_PATH;
if (invokedPath) {
  process.argv[1] = invokedPath;
}

process.stdout.write(JSON.stringify(detectPackageManagerDetails()));
