"""AI hook. Switched off (AI_PROVIDER=none) until the team picks a model.

To plug a provider in later, implement `_ask_<provider>(prompt) -> str` and set AI_PROVIDER.
The bot already calls `answer()` for free-text questions ending with «?» in private chat
and falls back to search when it returns None. `roadmap_context()` builds the prompt
context from the same storage the bot uses, so the model sees live tasks and milestones.
"""
from __future__ import annotations

from datetime import date
from typing import Optional

from . import config, logic
from .storage import Storage


def roadmap_context(st: Storage, today: date, max_tasks: int = 80) -> str:
    tasks = st.tasks()
    done, total, pct = logic.progress(tasks)
    rows = [f"Сегодня {today.isoformat()}. Прогресс {done}/{total} ({pct}%).",
            f"До запуска продаж {logic.days_to_launch(st.milestones(), today)} дней.", "Вехи:"]
    for m in st.milestones():
        rows.append(f"- {m.title} | {m.date} | {m.status} | {m.criterion}")
    rows.append("Задачи (этап | статус | срок | приоритет | название):")
    for t in sorted(tasks, key=lambda t: (t.done, t.due or date.max))[:max_tasks]:
        rows.append(f"- {t.stage} | {t.status} | {t.due or '—'} | {t.priority} | {t.title}")
    return "\n".join(rows)


SYSTEM_PROMPT = ("Ты — проектный наставник команды TheBearLab (конструктор плюшевых мишек для детей). "
                 "Отвечай кратко и по делу, опираясь на роадмап ниже. Если данных нет — так и скажи.")


class AIClient:
    def __init__(self, provider: str = config.AI_PROVIDER):
        self.provider = (provider or "none").lower()

    @property
    def enabled(self) -> bool:
        return self.provider != "none"

    def answer(self, question: str, st: Storage, today: date) -> Optional[str]:
        if not self.enabled:
            return None
        prompt = f"{SYSTEM_PROMPT}\n\n{roadmap_context(st, today)}\n\nВопрос: {question}"
        fn = getattr(self, f"_ask_{self.provider}", None)
        if fn is None:
            return None
        try:
            return fn(prompt)
        except Exception:  # never let AI break the bot
            return None

    # Providers are added here after the price decision, e.g.:
    # def _ask_gigachat(self, prompt: str) -> str: ...
    # def _ask_yandex(self, prompt: str) -> str: ...
