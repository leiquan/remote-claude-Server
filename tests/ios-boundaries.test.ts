import test from "node:test";

/**
 * The source suite scans ios/Sources for web views and telemetry.
 * This server repository does not contain that tree, so the scan is not run.
 * A skip is not a pass and is not an iOS execution.
 */
test(
  "iOS source boundary scan",
  {
    skip: "NOT EXECUTED: ios/ is not in this server repository, so the client source scan was not run",
  },
  () => {
    throw new Error("The iOS source scan was not executed.");
  },
);
