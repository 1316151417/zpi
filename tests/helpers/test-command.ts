/** Reject UI options before Playwright can start its inspector/trace viewer. */
export function assertBackgroundCommand(args: string[], env = process.env) {
  if (
    env.ZPI_TEST_SHOW_WINDOW === "1" ||
    env.ZPI_TEST_INTERACTIVE === "1" ||
    (env.PWDEBUG && env.PWDEBUG !== "0") ||
    args.some((arg) => /^--(?:ui|ui-host|ui-port|debug|headed|config)(?:=|$)|^-c/.test(arg))
  )
    throw new Error(
      "Default tests cannot show windows or replace their config. Use npm run test:interactive explicitly.",
    );
}
