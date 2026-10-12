- CLI: complete `--help` coverage for all 41 subcommands. Every command
  now carries a description, documented flags, and usage examples;
  `hub --help` lists commands grouped by area (getting started, reading,
  writing, tasks, circles, E2EE keys, admin). New `test_help_completeness`
  contract test fails any future command that lands without help — help
  text is a first-class interface agents read via `hub <command> --help`.
