#!/usr/bin/env python3
"""Help-completeness contract for the `hub` CLI.

The skill's discovery rule tells agents: "if any command's inputs are
unclear, run `hub <command> --help` before guessing." That rule only works
if every subcommand actually documents itself. This test enforces it:

- every subcommand (top-level and `hub circle <action>`) has a non-trivial
  one-line help string (shown in `hub --help`),
- every subcommand has a longer description (shown at the top of
  `hub <command> --help`),
- every subcommand carries at least one usage example in its epilog,
- every flag/argument on every subcommand has help text.

A new command that lands without help fails this test. Keep help written
for a model reader: explicit input formats, JSON shapes, and exit codes
where relevant.
"""

import argparse
import importlib.util
import os
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_help", HUB_PATH, loader=SourceFileLoader("hubcli_help", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


def _subparsers_of(parser):
    """Return {name: subparser} for an argparse parser's subcommands."""
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return action.choices
    return {}


def _iter_all_commands():
    """Yield (dotted_name, subparser) for every subcommand incl. circle actions."""
    top = _subparsers_of(hub.build_parser())
    for name, p in sorted(top.items()):
        yield name, p
        if name == "circle":
            for sub_name, sub_p in sorted(_subparsers_of(p).items()):
                yield "circle " + sub_name, sub_p


class TestHelpCompleteness(unittest.TestCase):
    def test_every_command_has_help_description_and_example(self):
        cmds = list(_iter_all_commands())
        # Guard against the test silently passing on an empty command set.
        self.assertGreaterEqual(len(cmds), 40,
                                "expected 40+ subcommands, parser grew/shrank?")
        problems = []
        for dotted, p in cmds:
            if len(p.description or "") < 40:
                problems.append(
                    "%s: description too short/missing (%d chars)" %
                    (dotted, len(p.description or "")))
            epilog = p.epilog or ""
            if "example" not in epilog.lower():
                problems.append("%s: no usage example in --help epilog" % dotted)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_one_line_help_present_in_top_level_listing(self):
        parser = hub.build_parser()
        listing = parser.format_help()
        for dotted, _ in _iter_all_commands():
            base = dotted.split()[0]
            # Each top-level command must appear with a help blurb; circle
            # actions appear under `hub circle --help`.
            self.assertIn(base, listing,
                          "top-level command missing from hub --help: " + base)
        circle_help = _subparsers_of(parser)["circle"].format_help()
        for dotted, _ in _iter_all_commands():
            if dotted.startswith("circle "):
                action = dotted.split()[1]
                self.assertIn(action, circle_help,
                              "circle action missing from help: " + dotted)

    def test_one_line_help_is_nontrivial(self):
        # The short help= strings shown in `hub --help` must say something
        # useful, not just repeat the command name.
        parser = hub.build_parser()
        # Reach the _SubParsersAction to read per-choice help strings.
        sub_action = next(
            a for a in parser._actions
            if isinstance(a, argparse._SubParsersAction))
        helps = {a.dest: a.help for a in sub_action._choices_actions}
        problems = [n for n, h in helps.items() if not h or len(h) < 15]
        self.assertEqual(problems, [],
                         "commands with missing/trivial one-line help: %s" % problems)
        circle_parser = _subparsers_of(parser)["circle"]
        circle_action = next(
            a for a in circle_parser._actions
            if isinstance(a, argparse._SubParsersAction))
        circle_helps = {a.dest: a.help for a in circle_action._choices_actions}
        problems = [n for n, h in circle_helps.items() if not h or len(h) < 15]
        self.assertEqual(problems, [],
                         "circle actions with trivial one-line help: %s" % problems)

    def test_every_flag_has_help_text(self):
        problems = []
        for dotted, p in _iter_all_commands():
            for action in p._actions:
                if isinstance(action, (argparse._SubParsersAction,
                                        argparse._HelpAction)):
                    continue
                if not action.help:
                    problems.append("%s: flag %s has no help text" %
                                    (dotted, action.dest))
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
