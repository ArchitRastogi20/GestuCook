# backend/langs.py
# Shared language constants: ISO code -> English name (for LLM prompts) and the
# localized time-unit words the step-timer parser must recognise.

LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "it": "Italian", "es": "Spanish"}

SECOND_UNITS = {
    "s", "sec", "secs", "second", "seconds",
    "secondo", "secondi",            # it
    "segundo", "segundos",           # es
    "सेकंड", "सेकण्ड",                  # hi
}
MINUTE_UNITS = {
    "m", "min", "mins", "minute", "minutes",
    "minuto", "minuti",              # it (minuto shared with es)
    "minutos",                       # es
    "मिनट", "मिनटों",                   # hi
}
HOUR_UNITS = {
    "hr", "hrs", "hour", "hours",
    "ora", "ore",                    # it
    "hora", "horas",                 # es
    "घंटा", "घंटे", "घण्टा", "घण्टे",        # hi
}
ALL_UNITS = SECOND_UNITS | MINUTE_UNITS | HOUR_UNITS
