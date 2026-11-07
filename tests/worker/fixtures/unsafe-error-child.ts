/**
 * Test probe: sends a valid error class with an unsafe message. The parent
 * process must replace the message with the fixed safe vocabulary.
 */
process.on("message", () => {
  process.send?.(
    {
      type: "error",
      name: "CheckerError",
      errorClass: "timeout",
      message: "timeout at https://customer.example/private?token=secret",
    },
    () => process.exit(0),
  );
});
