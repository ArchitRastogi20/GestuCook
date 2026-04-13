// app.js - GestuCook main application logic

var App = (function () {
    // state
    var userName = "";
    var mode = "";
    var detectedItems = [];
    var recipes = [];
    var currentRecipeIndex = 0;
    var currentStepIndex = 0;
    var selectedRecipe = null;
    var isCooking = false;
    var gesturesActive = false;
    var isRecording = false;
    var mediaRecorder = null;
    var audioChunks = [];
    var totalCost = { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 };

    // TTS state: prevent overlapping audio
    var currentAudio = null;
    var ttsInFlight = false;

    // DOM helpers
    function $(sel) { return document.querySelector(sel); }
    function $$(sel) { return document.querySelectorAll(sel); }

    // screens
    var screenWelcome, screenMode, screenPhoto, screenHandsfree, screenRecipes, screenCooking;
    var loader, loaderText, costDisplay, providerBadge;
    var webcamPip, webcamVideo, webcamCanvas, gestureHud, gestureDot, gestureLabel, gestureFeedback;

    function showScreen(screen) {
        var all = $$(".screen");
        for (var i = 0; i < all.length; i++) all[i].classList.remove("active");
        screen.classList.add("active");
    }

    function showLoader(text) {
        loaderText.textContent = text || "Loading...";
        loader.classList.add("active");
    }

    function hideLoader() {
        loader.classList.remove("active");
    }

    function updateCost(cost) {
        if (!cost) return;
        totalCost.input_tokens += cost.input_tokens || 0;
        totalCost.output_tokens += cost.output_tokens || 0;
        totalCost.total_cost_usd += cost.total_cost_usd || 0;
        costDisplay.innerHTML =
            "<b>$" + totalCost.total_cost_usd.toFixed(4) + "</b> | " +
            totalCost.input_tokens + " in / " +
            totalCost.output_tokens + " out";
    }

    function flashGesture(label) {
        gestureFeedback.textContent = label;
        gestureFeedback.classList.add("show");
        setTimeout(function () { gestureFeedback.classList.remove("show"); }, 600);
    }

    // ── TTS with queue / overlap prevention ──────────────
    function stopCurrentAudio() {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            currentAudio = null;
        }
    }

    async function readCurrentStep() {
        if (!selectedRecipe) return;
        if (ttsInFlight) return; // already fetching, ignore

        // stop any playing audio first
        stopCurrentAudio();

        var text = selectedRecipe.steps[currentStepIndex];
        ttsInFlight = true;

        try {
            var formData = new FormData();
            formData.append("text", text);
            var resp = await fetch("/api/tts", {
                method: "POST",
                body: formData,
            });
            if (resp.ok) {
                var blob = await resp.blob();
                var url = URL.createObjectURL(blob);
                var audio = new Audio(url);
                currentAudio = audio;

                audio.onended = function () {
                    currentAudio = null;
                    URL.revokeObjectURL(url);
                };
                audio.onerror = function () {
                    currentAudio = null;
                };

                audio.play();
            }
        } catch (e) {
            console.error("tts error:", e);
        } finally {
            ttsInFlight = false;
        }
    }

    // ── init ─────────────────────────────────────────────
    async function init() {
        screenWelcome = $("#screen-welcome");
        screenMode = $("#screen-mode");
        screenPhoto = $("#screen-photo");
        screenHandsfree = $("#screen-handsfree");
        screenRecipes = $("#screen-recipes");
        screenCooking = $("#screen-cooking");
        loader = $("#loader");
        loaderText = $("#loader-text");
        costDisplay = $("#cost-display");
        providerBadge = $("#provider-badge");
        webcamPip = $("#webcam-pip");
        webcamVideo = $("#webcam-video");
        webcamCanvas = $("#webcam-canvas");
        gestureHud = $("#gesture-hud");
        gestureDot = $("#gesture-dot");
        gestureLabel = $("#gesture-label");
        gestureFeedback = $("#gesture-feedback");

        // load config
        try {
            var resp = await fetch("/api/config");
            var cfg = await resp.json();
            providerBadge.textContent = cfg.provider + " : " + cfg.model;
        } catch (e) {
            providerBadge.textContent = "offline";
        }

        // welcome
        $("#btn-enter").addEventListener("click", function () {
            var name = $("#input-name").value.trim();
            if (!name) return;
            userName = name;
            showScreen(screenMode);
        });
        $("#input-name").addEventListener("keydown", function (e) {
            if (e.key === "Enter") $("#btn-enter").click();
        });

        // mode selection
        $("#mode-photo").addEventListener("click", function () {
            mode = "photo";
            showScreen(screenPhoto);
        });
        $("#mode-handsfree").addEventListener("click", function () {
            mode = "handsfree";
            showScreen(screenHandsfree);
            startGestures();
        });

        setupPhotoMode();
        setupHandsfreeMode();

        // cooking controls
        $("#btn-prev-step").addEventListener("click", prevStep);
        $("#btn-next-step").addEventListener("click", nextStep);
        $("#btn-read-step").addEventListener("click", readCurrentStep);
        $("#btn-exit-cooking").addEventListener("click", exitCooking);

        // gesture engine
        GestureEngine.init(webcamVideo, webcamCanvas, handleGesture);
    }

    // ── photo mode ───────────────────────────────────────
    function setupPhotoMode() {
        var zone = $("#upload-zone");
        var fileInput = $("#file-input");
        var thumbStrip = $("#thumb-strip");
        var selectedFiles = [];

        zone.addEventListener("click", function () { fileInput.click(); });
        zone.addEventListener("dragover", function (e) {
            e.preventDefault();
            zone.classList.add("dragover");
        });
        zone.addEventListener("dragleave", function () { zone.classList.remove("dragover"); });
        zone.addEventListener("drop", function (e) {
            e.preventDefault();
            zone.classList.remove("dragover");
            handleFiles(e.dataTransfer.files);
        });
        fileInput.addEventListener("change", function () { handleFiles(fileInput.files); });

        function handleFiles(files) {
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (!f.type.startsWith("image/")) continue;
                selectedFiles.push(f);
                var img = document.createElement("img");
                img.src = URL.createObjectURL(f);
                thumbStrip.appendChild(img);
            }
            if (selectedFiles.length > 0) {
                $("#btn-detect").disabled = false;
            }
        }

        // cuisine chips
        var chips = $$(".chip");
        for (var i = 0; i < chips.length; i++) {
            chips[i].addEventListener("click", function () {
                this.classList.toggle("selected");
            });
        }

        // detect button
        $("#btn-detect").addEventListener("click", async function () {
            if (selectedFiles.length === 0) return;
            showLoader("Detecting ingredients...");

            var allItems = [];
            for (var i = 0; i < selectedFiles.length; i++) {
                var formData = new FormData();
                formData.append("image", selectedFiles[i]);
                try {
                    var resp = await fetch("/api/detect", { method: "POST", body: formData });
                    var data = await resp.json();
                    if (data.items) allItems = allItems.concat(data.items);
                    updateCost(data.cost);
                } catch (e) {
                    console.error("detect error:", e);
                }
            }

            // deduplicate
            var seen = {};
            detectedItems = [];
            for (var i = 0; i < allItems.length; i++) {
                var key = allItems[i].toLowerCase().trim();
                if (!seen[key]) {
                    seen[key] = true;
                    detectedItems.push(allItems[i]);
                }
            }

            if (detectedItems.length === 0) {
                hideLoader();
                alert("Could not detect any food items. Please try clearer images.");
                return;
            }

            showLoader("Generating recipes...");
            var selChips = $$(".chip.selected");
            var cuisines = [];
            for (var i = 0; i < selChips.length; i++) cuisines.push(selChips[i].dataset.cuisine);
            await fetchRecipes(detectedItems, cuisines);
            hideLoader();
            showRecipesScreen();
        });
    }

    // ── handsfree mode ───────────────────────────────────
    function setupHandsfreeMode() {
        var micBtn = $("#mic-btn");
        var transcript = $("#voice-transcript");
        var ingredientsList = $("#ingredients-list");

        micBtn.addEventListener("click", toggleRecording);

        async function toggleRecording() {
            if (isRecording) {
                stopRecording();
                return;
            }
            try {
                var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorder.ondataavailable = function (e) { audioChunks.push(e.data); };
                mediaRecorder.onstop = async function () {
                    stream.getTracks().forEach(function (t) { t.stop(); });
                    var blob = new Blob(audioChunks, { type: "audio/webm" });
                    transcript.textContent = "Transcribing...";
                    await transcribeAudio(blob);
                };
                mediaRecorder.start();
                isRecording = true;
                micBtn.classList.add("recording");
                transcript.textContent = "Listening...";
            } catch (e) {
                console.error("mic error:", e);
                transcript.textContent = "Microphone access denied.";
            }
        }

        function stopRecording() {
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop();
            }
            isRecording = false;
            micBtn.classList.remove("recording");
        }

        async function transcribeAudio(blob) {
            var formData = new FormData();
            formData.append("audio", blob, "recording.webm");
            try {
                var resp = await fetch("/api/asr", { method: "POST", body: formData });
                var data = await resp.json();
                var text = data.text || "";
                transcript.textContent = text || "Could not transcribe. Try again.";
                if (text) {
                    var items = parseIngredients(text);
                    detectedItems = items;
                    renderIngredients(items, ingredientsList);
                    $("#btn-handsfree-go").disabled = items.length === 0;
                }
            } catch (e) {
                console.error("asr error:", e);
                transcript.textContent = "ASR service unavailable.";
            }
        }

        function parseIngredients(text) {
            return text
                .toLowerCase()
                .replace(/i have|i got|there is|there are|some|please|recipe|with/gi, "")
                .split(/[,\n]|and/)
                .map(function (s) { return s.trim(); })
                .filter(function (s) { return s.length > 1 && s.length < 40; });
        }

        function renderIngredients(items, container) {
            container.innerHTML = items
                .map(function (it) { return '<span class="ingredient-tag">' + it + "</span>"; })
                .join("");
        }

        $("#btn-handsfree-go").addEventListener("click", async function () {
            if (detectedItems.length === 0) return;
            showLoader("Generating recipes...");
            await fetchRecipes(detectedItems, []);
            hideLoader();
            showRecipesScreen();
        });
    }

    // ── recipes ──────────────────────────────────────────
    async function fetchRecipes(items, cuisines) {
        try {
            var resp = await fetch("/api/recipes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ingredients: items, cuisines: cuisines, count: 3 }),
            });
            var data = await resp.json();
            recipes = data.recipes || [];
            updateCost(data.cost);
        } catch (e) {
            console.error("recipes error:", e);
            recipes = [];
        }
    }

    function showRecipesScreen() {
        if (recipes.length === 0) {
            alert("No recipes generated. Try different ingredients.");
            return;
        }
        currentRecipeIndex = 0;
        renderCarousel();
        showScreen(screenRecipes);
        startGestures();

        var itemsHtml = detectedItems
            .map(function (it) { return '<span class="ingredient-tag">' + it + "</span>"; })
            .join("");
        $("#detected-items-display").innerHTML = itemsHtml;
    }

    function renderCarousel() {
        var track = $("#carousel-track");
        var dots = $("#carousel-dots");

        track.innerHTML = recipes
            .map(function (r, i) {
                var ingList = r.ingredients
                    .map(function (ing) { return "<li>" + ing + "</li>"; }).join("");
                var stepList = r.steps
                    .map(function (s) { return "<li>" + s + "</li>"; }).join("");
                return (
                    '<div class="recipe-card"><div class="recipe-inner">' +
                    "<h2>" + r.name + "</h2>" +
                    '<div class="recipe-meta">' +
                    "<span>Prep: " + (r.prep_time || "N/A") + "</span>" +
                    "<span>Cook: " + (r.cook_time || "N/A") + "</span>" +
                    "<span>Serves: " + (r.servings || "N/A") + "</span></div>" +
                    '<p class="recipe-desc">' + (r.description || "") + "</p>" +
                    '<div class="recipe-section-label">Ingredients</div>' +
                    '<ul class="recipe-ingredients">' + ingList + "</ul>" +
                    '<div class="recipe-section-label">Steps</div>' +
                    '<ol class="recipe-steps">' + stepList + "</ol>" +
                    '<div style="margin-top:1.25rem;text-align:center;">' +
                    '<button class="btn btn-primary btn-select-recipe" data-index="' + i + '">' +
                    "Cook This</button></div></div></div>"
                );
            }).join("");

        dots.innerHTML = recipes
            .map(function (_, i) {
                return '<button class="carousel-dot' +
                    (i === 0 ? " active" : "") +
                    '" data-index="' + i + '"></button>';
            }).join("");

        var dotEls = dots.querySelectorAll(".carousel-dot");
        for (var i = 0; i < dotEls.length; i++) {
            dotEls[i].addEventListener("click", function () {
                goToRecipe(parseInt(this.dataset.index));
            });
        }
        var btnEls = track.querySelectorAll(".btn-select-recipe");
        for (var i = 0; i < btnEls.length; i++) {
            btnEls[i].addEventListener("click", function () {
                startCooking(parseInt(this.dataset.index));
            });
        }

        $("#carousel-prev").addEventListener("click", prevRecipe);
        $("#carousel-next").addEventListener("click", nextRecipe);
        updateCarousel();
    }

    function goToRecipe(i) {
        currentRecipeIndex = Math.max(0, Math.min(i, recipes.length - 1));
        updateCarousel();
    }
    function prevRecipe() { goToRecipe(currentRecipeIndex - 1); }
    function nextRecipe() { goToRecipe(currentRecipeIndex + 1); }

    function updateCarousel() {
        var track = $("#carousel-track");
        track.style.transform = "translateX(-" + (currentRecipeIndex * 100) + "%)";
        var allDots = $$(".carousel-dot");
        for (var i = 0; i < allDots.length; i++) {
            allDots[i].classList.toggle("active", i === currentRecipeIndex);
        }
    }

    // ── cooking mode ─────────────────────────────────────
    function startCooking(index) {
        stopCurrentAudio();
        selectedRecipe = recipes[index];
        currentStepIndex = 0;
        isCooking = true;
        showScreen(screenCooking);
        renderCookingStep();
    }

    function renderCookingStep() {
        if (!selectedRecipe) return;
        var steps = selectedRecipe.steps;
        $("#cooking-recipe-name").textContent = selectedRecipe.name;

        var pips = $("#step-progress");
        pips.innerHTML = steps.map(function (_, i) {
            var cls = "step-pip";
            if (i < currentStepIndex) cls += " done";
            if (i === currentStepIndex) cls += " current";
            return '<div class="' + cls + '"></div>';
        }).join("");

        $("#cooking-step-num").textContent =
            "Step " + (currentStepIndex + 1) + " of " + steps.length;
        $("#cooking-step-text").textContent = steps[currentStepIndex];
    }

    function nextStep() {
        if (!selectedRecipe) return;
        if (currentStepIndex < selectedRecipe.steps.length - 1) {
            stopCurrentAudio();
            currentStepIndex++;
            renderCookingStep();
        }
    }

    function prevStep() {
        if (currentStepIndex > 0) {
            stopCurrentAudio();
            currentStepIndex--;
            renderCookingStep();
        }
    }

    function exitCooking() {
        stopCurrentAudio();
        isCooking = false;
        selectedRecipe = null;
        showScreen(screenRecipes);
    }

    // ── gesture handling ─────────────────────────────────
    async function startGestures() {
        if (gesturesActive) return;
        try {
            gesturesActive = true;
            webcamPip.classList.remove("hidden");
            gestureHud.classList.remove("hidden");
            await GestureEngine.start();
            gestureDot.classList.add("active");
        } catch (e) {
            console.error("gesture start error:", e);
            gesturesActive = false;
        }
    }

    function handleGesture(gesture) {
        gestureLabel.textContent = gesture.replace(/_/g, " ");

        if (isCooking) {
            handleCookingGesture(gesture);
        } else if (screenRecipes.classList.contains("active")) {
            handleCarouselGesture(gesture);
        }
    }

    function handleCarouselGesture(gesture) {
        switch (gesture) {
            case "swipe_right":
                flashGesture(">>>");
                nextRecipe();
                break;
            case "swipe_left":
                flashGesture("<<<");
                prevRecipe();
                break;
            case "thumbs_up":
                flashGesture("OK!");
                startCooking(currentRecipeIndex);
                break;
            case "fist":
                flashGesture("Back");
                showScreen(screenMode);
                stopGestures();
                break;
        }
    }

    function handleCookingGesture(gesture) {
        switch (gesture) {
            case "swipe_right":
                flashGesture(">>>");
                nextStep();
                break;
            case "swipe_left":
                flashGesture("<<<");
                prevStep();
                break;
            case "open_palm":
                flashGesture("Read");
                readCurrentStep();
                break;
            case "thumbs_up":
                flashGesture("Next!");
                nextStep();
                break;
            case "fist":
                flashGesture("Exit");
                exitCooking();
                break;
        }
    }

    function stopGestures() {
        GestureEngine.stop();
        gesturesActive = false;
        webcamPip.classList.add("hidden");
        gestureHud.classList.add("hidden");
        gestureDot.classList.remove("active");
    }

    return { init: init };
})();

document.addEventListener("DOMContentLoaded", App.init);
