"""Slash command routing and built-in handlers."""

from a9bot.command.builtin import register_builtin_commands
from a9bot.command.router import CommandContext, CommandRouter

__all__ = ["CommandContext", "CommandRouter", "register_builtin_commands"]
