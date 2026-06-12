# backend/demo.py
# Demo-recording mode. When DEMO_MODE is on (env, via docker-compose):
#   * /api/recipes returns these three fixed Indian recipes instantly,
#   * /api/qa answers any salt-quantity question from DEMO_QA_SALT_ANSWER.
# Everything else (ASR, TTS, gestures, session logging) stays live, and any
# non-salt question still goes to the real LLM, so the demo cannot dead-end.
import os
import re

DEMO_MODE = os.getenv("DEMO_MODE", "false").strip().lower() in ("1", "true", "yes", "on")

# Steps are plain strings on purpose: main.enrich_recipes() converts them to
# {text, duration_seconds} so the cooking screen's step timers work unchanged.
# Recipe 1 is the dish cooked on camera; recipes 2-3 were generated once with
# the configured LLM from the same five spoken ingredients and baked in.
DEMO_RECIPES = {
    "recipes": [
        {
            "name": "Indian Vegetable Pulao",
            "cuisine": "Indian",
            "description": "Fragrant one-pot rice with garden vegetables and whole spices.",
            "long_description": (
                "A weeknight pulao where basmati rice steams together with potatoes, "
                "carrots and French beans over a cumin-and-chili tempering. One pot, "
                "open pan or pressure cooker, ready in about forty minutes."
            ),
            "difficulty": "Easy",
            "prep_time": "15 min",
            "cook_time": "25 min",
            "total_time": "40 min",
            "servings": 4,
            "ingredients": [
                {"name": "basmati rice", "qty": "1.5 cups (300 g)"},
                {"name": "onions", "qty": "2 medium, finely chopped"},
                {"name": "potatoes", "qty": "2 medium, cubed"},
                {"name": "carrots", "qty": "2, chopped"},
                {"name": "French beans", "qty": "a handful (100 g), chopped"},
                {"name": "garlic", "qty": "4 cloves, finely chopped"},
                {"name": "ghee or neutral oil", "qty": "3 tbsp"},
                {"name": "cumin seeds", "qty": "1 tsp"},
                {"name": "dried red chilies", "qty": "2 whole"},
                {"name": "coriander powder", "qty": "1 tsp"},
                {"name": "turmeric powder", "qty": "1/2 tsp"},
                {"name": "salt", "qty": "about 1.5 tsp, to taste"},
                {"name": "water", "qty": "2.5 cups"},
            ],
            "steps": [
                "Rinse one and a half cups of basmati rice in cold water until the water runs clear, then set it aside to drain.",
                "Finely chop 2 medium onions and 4 cloves of garlic.",
                "Cut 2 potatoes into small cubes, and chop 2 carrots and a handful of French beans into bite-size pieces.",
                "Heat 3 tablespoons of ghee or oil in a heavy pot or pressure cooker over medium heat for about 2 minutes.",
                "Add 1 teaspoon of cumin seeds and 2 dried red chilies, and let them sizzle for about 30 seconds until fragrant.",
                "Add the chopped onions and garlic and saute for about 4 minutes until soft and lightly golden.",
                "Add the potatoes, carrots and French beans with 1 teaspoon of salt, and saute for about 3 minutes - the salt helps the vegetables soften.",
                "Stir in 1 teaspoon of coriander powder and half a teaspoon of turmeric, and saute for about 1 minute, stirring so the spices do not burn.",
                "Add the drained rice and stir gently for about 1 minute to coat every grain in the spiced ghee.",
                "Pour in two and a half cups of water, then taste and adjust the salt - the water should taste just slightly salty.",
                "If cooking in an open pot, bring it to a boil, then cover and simmer on low for about 12 minutes until the rice is soft and the water is absorbed. In a pressure cooker, close the lid and cook for 1 to 2 whistles, then let the pressure release.",
                "Turn off the heat, let the pulao rest for 5 minutes, then fluff it with a fork and serve hot.",
            ],
        },
        {
            "name": "Indian-Style Vegetable Sabzi with Garlic & Beans",
            "cuisine": "Indian",
            "description": "A simple, fragrant mixed-vegetable sabzi with garlic and tender French beans.",
            "long_description": (
                "This is a dry-ish Indian vegetable sabzi where onions and garlic build "
                "a flavorful base, then potatoes, carrots, and French beans cook until "
                "tender. Expect a comforting, lightly spiced aroma and vegetables that "
                "are cooked through but still hold their shape."
            ),
            "difficulty": "Easy",
            "prep_time": "20 min",
            "cook_time": "35 min",
            "total_time": "55 min",
            "servings": 4,
            "ingredients": [
                {"name": "onions", "qty": "1 large (about 200 g), finely chopped"},
                {"name": "French beans", "qty": "250 g, trimmed and cut into 1-inch pieces"},
                {"name": "carrots", "qty": "2 medium (about 160 g), diced"},
                {"name": "potatoes", "qty": "2 medium (about 300 g), diced"},
                {"name": "garlic", "qty": "6 cloves (about 18 g), minced"},
            ],
            "steps": [
                "Heat 2 tbsp (30 ml) cooking oil in a large pan over medium heat for 1 minute.",
                "Add 1 large (200 g) finely chopped onions and cook for 8 minutes, stirring often, until soft and light golden.",
                "Add 18 g minced garlic and cook for 1 minute over medium heat, stirring, until fragrant.",
                "Add the diced potatoes (300 g) and carrots (160 g) and stir for 2 minutes over medium heat to coat.",
                "Add 250 g French beans and stir for 2 minutes over medium heat.",
                "Sprinkle 1 tsp salt and 1/2 tsp black pepper over the vegetables and stir for 30 seconds over medium heat.",
                "Pour in 1/2 cup (120 ml) water and stir, then bring to a simmer over medium-low heat for about 5 minutes, until the water is mostly absorbed.",
                "Cover the pan and cook for 10 minutes over medium-low heat, stirring once halfway, until potatoes are nearly tender.",
                "Uncover and cook for 8 minutes over medium heat, stirring occasionally, until vegetables are tender and the mixture looks drier.",
                "Taste and adjust salt if needed, then cook for 1 to 2 minutes over medium heat until the flavors are well combined.",
            ],
        },
        {
            "name": "Garlic-Onion Potato & Green Bean Curry",
            "cuisine": "Indian",
            "description": "A cozy Indian curry-style sabzi with garlic-onion gravy and tender beans.",
            "long_description": (
                "This curry is made by simmering potatoes and French beans in a "
                "garlic-onion gravy until it thickens and clings to the vegetables. "
                "It's hearty, mildly aromatic, and ideal with roti or rice - without "
                "needing tomatoes."
            ),
            "difficulty": "Medium",
            "prep_time": "25 min",
            "cook_time": "30 min",
            "total_time": "55 min",
            "servings": 4,
            "ingredients": [
                {"name": "onions", "qty": "1 large (about 200 g), finely chopped"},
                {"name": "French beans", "qty": "250 g, trimmed and cut into 1-inch pieces"},
                {"name": "carrots", "qty": "1 medium (about 80 g), diced"},
                {"name": "potatoes", "qty": "2 medium (about 300 g), cubed"},
                {"name": "garlic", "qty": "6 cloves (about 18 g), minced"},
            ],
            "steps": [
                "Heat 2 tbsp (30 ml) cooking oil in a pot over medium heat for 1 minute.",
                "Add the chopped onions (200 g) and cook for 10 minutes over medium heat, stirring frequently, until deep golden and caramel-smelling.",
                "Add the minced garlic (18 g) and cook for 1 minute over medium heat, stirring until fragrant.",
                "Add the cubed potatoes (300 g) and diced carrot (80 g) and stir for 2 minutes over medium heat.",
                "Add 1 1/2 tsp salt and 1/2 tsp black pepper and stir for 30 seconds over medium heat.",
                "Add 3/4 cup (180 ml) water and stir, then bring to a simmer over medium-low heat for about 8 minutes, until potatoes start to soften.",
                "Add the French beans (250 g) and stir to combine.",
                "Cover and cook for 10 minutes over medium-low heat, stirring once halfway, until beans are bright green and tender.",
                "Uncover and cook for 6 to 8 minutes over medium heat, stirring often, until the gravy thickens and coats the vegetables.",
                "Turn off the heat and rest for 5 minutes so the sauce thickens slightly before serving.",
            ],
        },
    ]
}

DEMO_QA_SALT_ANSWER = (
    "About one and a half teaspoons of salt in total for this pot. You already "
    "added one teaspoon with the vegetables, so taste the water after adding "
    "the rice and adjust from there."
)

_SALT_RE = re.compile(r"salt", re.IGNORECASE)


def match_demo_qa(question: str):
    """Cached answer for the demo's scripted question, else None (-> live LLM).
    Matches any phrasing that mentions salt: the ASR may garble everything
    around the keyword, and in demo mode a salt question is the scripted one."""
    if question and _SALT_RE.search(question):
        return DEMO_QA_SALT_ANSWER
    return None
