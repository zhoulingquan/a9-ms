"""Message bus module for decoupled channel-agent communication."""

from munchkin.bus.events import InboundMessage, OutboundMessage
from munchkin.bus.queue import MessageBus

__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]
