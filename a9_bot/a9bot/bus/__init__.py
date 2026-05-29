"""Message bus module for decoupled channel-agent communication."""

from a9bot.bus.events import InboundMessage, OutboundMessage
from a9bot.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
