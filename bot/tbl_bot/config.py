"""Settings. Everything secret comes from environment variables, never from the repo."""
from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta, timezone

TZ = timezone(timedelta(hours=3))          # Moscow, no DST

BOT_NAME = "the Bear Lab Bot"
LAUNCH_DATE = date.fromisoformat(os.environ.get("TBL_LAUNCH_DATE", "2027-02-05"))
LAUNCH_MILESTONE = "Запуск продаж"
# New-year break: no deadlines, no reminders, streak is not broken.
HOLIDAY_START = date.fromisoformat(os.environ.get("TBL_HOLIDAY_START", "2027-01-01"))
HOLIDAY_END = date.fromisoformat(os.environ.get("TBL_HOLIDAY_END", "2027-01-11"))

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
# Telegram ids that are always admins (separated by ; or ,). If empty, the first /start becomes admin.
ADMIN_IDS = {int(x) for x in re.split(r"[,; ]+", os.environ.get("ADMIN_IDS", "")) if x.strip()}

# AI is switched off for now; see tbl_bot/ai.py
AI_PROVIDER = os.environ.get("AI_PROVIDER", "none")

NOTION_TOKEN = os.environ.get("NOTION_TOKEN", "")
# Shared secret for /cron/* endpoints (Cloud Scheduler sends it in the X-Cron-Secret header).
CRON_SECRET = os.environ.get("CRON_SECRET", "")

# Scheduled jobs, Moscow time. A job fires on the first tick in [time, time + 2h).
JOBS = {
    "morning": {"hour": 9, "minute": 0, "weekday": None},
    "evening": {"hour": 18, "minute": 0, "weekday": None},
    "weekly": {"hour": 18, "minute": 0, "weekday": 4},     # Friday
}

NOTION_TASKS_DB = os.environ.get("NOTION_TASKS_DB", "68024e36533543438e3ba32e71a2b314")
NOTION_MILESTONES_DB = os.environ.get("NOTION_MILESTONES_DB", "505ce45d15a446ab9fe86649958dd598")
NOTION_IDEAS_DB = os.environ.get("NOTION_IDEAS_DB", "ad2d8120e9404cc099eb400aeeaef8d2")
NOTION_PROJECT_PAGE = os.environ.get("NOTION_PROJECT_PAGE", "40eccd0734e1813badebe73e72c40d2f")


def now() -> datetime:
    return datetime.now(TZ)


def today() -> date:
    return now().date()


def notion_url(page_id: str) -> str:
    return "https://www.notion.so/" + page_id.replace("-", "")
