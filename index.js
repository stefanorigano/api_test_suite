// ============================================================================
// LIFECYCLE MONITOR (Vanilla JS - Loads First)
// ============================================================================

const LifecycleMonitor = (function() {
    'use strict';
    
    const STORAGE_KEY = 'LifecycleMonitor_Events';
    const MAX_EVENTS = 200;
    
    // DOM Selectors
    const SELECTORS = {
        // Context detection
        MAIN_MENU: 'main.justify-center',
        IN_GAME_MENU: 'div[data-mod-id="escape-menu"]',
        LOAD_SAVE_SCREEN: 'main.grid.gap-8.min-h-screen.p-8.max-w-4xl.mx-auto',
        
        // In-game time
        CLOCK_DAY: 'div[data-mod-id="clock"] p.font-medium',
        CLOCK_TIME: 'div[data-mod-id="clock"] p.font-mono'
    };
    
    // State machine
    const STATES = {
        UNINITIALIZED: 'uninitialized',
        API_READY: 'api_ready',
        USER_STARTING_NEW_GAME: 'user_starting_new_game',
        USER_LOADING_SAVE: 'user_loading_save',
        CITY_LOADING: 'city_loading',
        GAME_INIT: 'game_init',
        IN_GAME: 'in_game',
        MENU: 'menu'
    };
    
    const VALID_TRANSITIONS = {
        [STATES.UNINITIALIZED]: [STATES.API_READY],
        [STATES.API_READY]: [STATES.USER_STARTING_NEW_GAME, STATES.USER_LOADING_SAVE, STATES.CITY_LOADING, STATES.GAME_INIT],
        [STATES.USER_STARTING_NEW_GAME]: [STATES.CITY_LOADING, STATES.GAME_INIT],
        [STATES.USER_LOADING_SAVE]: [STATES.CITY_LOADING, STATES.GAME_INIT],
        [STATES.CITY_LOADING]: [STATES.GAME_INIT, STATES.IN_GAME],
        [STATES.GAME_INIT]: [STATES.IN_GAME],
        [STATES.IN_GAME]: [STATES.MENU, STATES.CITY_LOADING, STATES.USER_LOADING_SAVE],
        [STATES.MENU]: [STATES.USER_STARTING_NEW_GAME, STATES.USER_LOADING_SAVE, STATES.CITY_LOADING, STATES.GAME_INIT]
    };
    
    // Monitor state
    let currentState = STATES.UNINITIALIZED;
    let events = [];
    let startTime = Date.now();
    let saveName = null;
    let cityCode = null;
    let isCollapsed = false;
    let validTransitions = 0;
    let errorCount = 0;
    
    // User action tracking
    let pendingLoadSaveName = null;
    let loadClickTime = null;
    
    // Scenario tracking
    const scenarios = {
        'new_game_from_menu': { detected: false, name: 'New Game from Menu' },
        'load_save_from_menu': { detected: false, name: 'Load Save from Menu' },
        'game_to_menu_to_new': { detected: false, name: 'Game → Menu → New Game' },
        'game_reload_same_save': { detected: false, name: 'Game → Reload Same Save' },
        'game_load_different_save': { detected: false, name: 'Game → Load Different Save' }
    };
    
    // UI Elements
    let panel = null;
    let timelineEl = null;
    let stateEl = null;
    let saveNameEl = null;
    let statsEl = null;
    let scenariosEl = null;
    let contentEl = null;
    let toggleBtn = null;
    
    // ============================================================================
    // CORE FUNCTIONS
    // ============================================================================
    
    function init() {
        loadEvents();
        createPanel();
        logEvent('Script Loaded', 'system');
        
        // Setup DOM listeners immediately
        setupDOMListeners();
        
        // Wait for API
        const checkAPI = setInterval(() => {
            if (window.SubwayBuilderAPI) {
                clearInterval(checkAPI);
                onAPIReady();
            }
        }, 100);
        
        console.info('[LIFECYCLE] Monitor initialized');
    }
    
    function setupDOMListeners() {
        // Use event delegation for dynamically added elements
        document.addEventListener('click', (e) => {
            const target = e.target;
            
            // Helper to check if click is within an element
            const isWithin = (selector) => target.closest(selector) !== null;
            
            // New Game (Main Menu)
            if (isWithin('main.justify-center') && target.textContent.includes('New Game')) {
                const context = detectContext();
                logEvent('User clicked: New Game', 'user_action');
                
                if (context === 'main_menu') {
                    transitionState(STATES.USER_STARTING_NEW_GAME);
                    detectScenario('user_new_game_from_menu');
                }
            }
            
            // Load/Save from Main Menu
            if (isWithin('main.justify-center') && target.textContent.includes('Load/Save')) {
                logEvent('User clicked: Load/Save (Main Menu)', 'user_action');
            }
            
            // Load/Save from In-Game Menu
            if (isWithin('div[data-mod-id="escape-menu"]') && target.textContent.includes('Load/Save')) {
                logEvent('User clicked: Load/Save (In-Game)', 'user_action');
            }
            
            // Load Button (specific save)
            if (isWithin('button') && 
                target.textContent.includes('Load') &&
                isWithin('main.grid.gap-8')) {
                
                const saveBlock = target.closest('.panel-blur');
                const saveNameEl = saveBlock?.querySelector('.text-base.font-black');
                const clickedSaveName = saveNameEl?.textContent.trim() || 'unknown';
                
                logEvent(`User clicked: Load "${clickedSaveName}"`, 'user_action');
                
                // Track for verification when load completes
                pendingLoadSaveName = clickedSaveName;
                loadClickTime = Date.now();
                
                const context = detectContext();
                if (context === 'in_game') {
                    transitionState(STATES.USER_LOADING_SAVE);
                } else {
                    transitionState(STATES.USER_LOADING_SAVE);
                }
            }
            
            // Save Button
            if (isWithin('button') && 
                target.textContent.includes('Save') &&
                target.closest('.grid.gap-2')) {
                
                const saveInput = document.querySelector('input[placeholder="Enter save name..."]');
                const saveNameToSave = saveInput?.value || 'unnamed';
                
                logEvent(`User clicked: Save "${saveNameToSave}"`, 'user_action');
            }
            
            // Menu Toggle (hamburger)
            if (isWithin('.lucide-menu')) {
                const menuVisible = document.querySelector('div[data-mod-id="escape-menu"]') !== null;
                logEvent(`User clicked: ${menuVisible ? 'Close' : 'Open'} Menu`, 'user_action');
            }
            
        }, true); // Use capture phase
        
        logEvent('DOM listeners initialized', 'system');
    }
    
    function detectContext() {
        if (document.querySelector(SELECTORS.MAIN_MENU)) {
            return 'main_menu';
        }
        if (document.querySelector(SELECTORS.IN_GAME_MENU)) {
            return 'in_game';
        }
        if (document.querySelector(SELECTORS.LOAD_SAVE_SCREEN)) {
            return 'load_save_screen';
        }
        return 'unknown';
    }
    
    function onAPIReady() {
        logEvent('API Available', 'api');
        transitionState(STATES.API_READY);
        
        // Hook call counters
        let gameInitCount = 0;
        let cityLoadCount = 0;
        let mapReadyCount = 0;
        
        // Register hooks
        const api = window.SubwayBuilderAPI;
        
        api.hooks.onGameInit(() => {
            gameInitCount++;
            logEvent(`Game Init (call #${gameInitCount})`, 'lifecycle');
            
            if (gameInitCount > 1) {
                logEvent(`Game Init called multiple times! (${gameInitCount} total)`, 'error', true);
                errorCount++;
                updateStats();
            }
            
            // Only transition to GAME_INIT if we're in an earlier state
            if (currentState === STATES.CITY_LOADING || 
                currentState === STATES.USER_STARTING_NEW_GAME ||
                currentState === STATES.USER_LOADING_SAVE ||
                currentState === STATES.API_READY) {
                transitionState(STATES.GAME_INIT);
            } else {
                logEvent(`Game Init in unexpected state: ${currentState}`, 'info');
            }
        });
        
        api.hooks.onCityLoad((code) => {
            cityLoadCount++;
            cityCode = code;
            logEvent(`City Load: ${code} (call #${cityLoadCount})`, 'lifecycle');
            
            if (cityLoadCount > 1 && currentState !== STATES.IN_GAME && currentState !== STATES.GAME_INIT) {
                logEvent(`City Load called multiple times in same session! (${cityLoadCount} total)`, 'error', true);
                errorCount++;
                updateStats();
            }
            
            // Transition to CITY_LOADING state
            if (currentState === STATES.API_READY || 
                currentState === STATES.MENU ||
                currentState === STATES.USER_STARTING_NEW_GAME ||
                currentState === STATES.USER_LOADING_SAVE) {
                transitionState(STATES.CITY_LOADING);
            } else if (currentState === STATES.IN_GAME || currentState === STATES.GAME_INIT) {
                // Reloading a save while in game
                transitionState(STATES.CITY_LOADING);
            }
            
            updatePanel();
        });
        
        api.hooks.onMapReady(() => {
            mapReadyCount++;
            logEvent(`Map Ready (call #${mapReadyCount})`, 'lifecycle');
            
            if (mapReadyCount > 1 && currentState === STATES.IN_GAME) {
                logEvent(`Map Ready called multiple times! (${mapReadyCount} total)`, 'error', true);
                errorCount++;
                updateStats();
            }
            
            // Transition to IN_GAME if we're in GAME_INIT or CITY_LOADING
            if (currentState === STATES.GAME_INIT || currentState === STATES.CITY_LOADING) {
                transitionState(STATES.IN_GAME);
            }
            
            detectScenario('map_ready');
        });
        
        api.hooks.onGameLoaded((name) => {
            const wasSameSave = saveName === name;
            saveName = name;
            
            // Verify load completion if we were tracking a pending load
            if (pendingLoadSaveName && loadClickTime) {
                const loadDuration = Date.now() - loadClickTime;
                const nameMatches = pendingLoadSaveName === name;
                
                if (nameMatches) {
                    logEvent(`Game Loaded: ${name} (took ${(loadDuration / 1000).toFixed(1)}s)`, 'lifecycle');
                } else {
                    logEvent(`Game Loaded: ${name} (expected "${pendingLoadSaveName}")`, 'error', true);
                    errorCount++;
                }
                
                pendingLoadSaveName = null;
                loadClickTime = null;
            } else {
                logEvent(`Game Loaded: ${name}${wasSameSave ? ' (SAME)' : ''}`, 'lifecycle');
            }
            
            if (wasSameSave) {
                detectScenario('reload_same_save');
            } else if (saveName) {
                detectScenario('load_different_save');
            }
            
            updatePanel();
        });
        
        api.hooks.onGameSaved((name) => {
            logEvent(`Game Saved: ${name}`, 'lifecycle');
        });
        
        // Test onDemandChange hook (known bug: fires incorrectly)
        let demandChangeCount = 0;
        let demandChangeDuringGameplay = 0;
        
        api.hooks.onDemandChange((popCount) => {
            demandChangeCount++;
            const inGameplay = currentState === STATES.IN_GAME;
            
            if (inGameplay) {
                demandChangeDuringGameplay++;
            }
            
            logEvent(`onDemandChange fired (call #${demandChangeCount}, ${inGameplay ? 'IN-GAME' : 'PRE-GAME'}, pops: ${popCount})`, 'lifecycle');
            
            // After a reasonable period, check if it behaved correctly
            if (demandChangeCount >= 3) {
                const behavedCorrectly = demandChangeDuringGameplay > 0 && demandChangeCount <= 3;
                
                if (!behavedCorrectly) {
                    logEvent(`onDemandChange behavior incorrect: ${demandChangeCount} total calls, ${demandChangeDuringGameplay} during gameplay`, 'error', true);
                    errorCount++;
                    updateStats();
                }
            }
        });
    }
    
    function logEvent(message, type = 'info', isError = false) {
        const timestamp = Date.now() - startTime;
        const event = {
            timestamp,
            message,
            type,
            isError,
            state: currentState,
            time: new Date().toISOString()
        };
        
        events.push(event);
        
        // Trim to max events
        if (events.length > MAX_EVENTS) {
            events = events.slice(-MAX_EVENTS);
        }
        
        saveEvents();
        updateTimeline();
        
        const icon = isError ? '❌' : type === 'system' ? '🔧' : type === 'api' ? '⚙️' : type === 'user_action' ? '👆' : '🎮';
        console.info(`[LIFECYCLE] ${icon} ${formatTimestamp(timestamp)} - ${message}`);
    }
    
    function transitionState(newState) {
        const validTransition = VALID_TRANSITIONS[currentState]?.includes(newState);
        
        if (!validTransition && currentState !== STATES.UNINITIALIZED) {
            errorCount++;
            logEvent(
                `Invalid transition: ${currentState} → ${newState}`,
                'error',
                true
            );
            updateStats();
            return false;
        }
        
        const oldState = currentState;
        currentState = newState;
        validTransitions++;
        
        logEvent(`State: ${oldState} → ${newState}`, 'transition');
        updateStats();
        updateState();
        
        return true;
    }
    
    function detectScenario(trigger) {
        // New Game from Menu
        if (trigger === 'user_new_game_from_menu') {
            scenarios.new_game_from_menu.detected = true;
        }
        
        // Load Save from Menu
        if (trigger === 'map_ready' && saveName && events.length <= 10) {
            scenarios.load_save_from_menu.detected = true;
        }
        
        // Game → Reload Same Save
        if (trigger === 'reload_same_save') {
            scenarios.game_reload_same_save.detected = true;
        }
        
        // Game → Load Different Save
        if (trigger === 'load_different_save') {
            scenarios.game_load_different_save.detected = true;
        }
        
        updateScenarios();
    }
    
    // ============================================================================
    // STORAGE
    // ============================================================================
    
    function loadEvents() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const data = JSON.parse(stored);
                events = data.events || [];
                validTransitions = data.validTransitions || 0;
                errorCount = data.errorCount || 0;
            }
        } catch (error) {
            console.error('[LIFECYCLE] Failed to load events:', error);
            events = [];
        }
    }
    
    function saveEvents() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                events,
                validTransitions,
                errorCount,
                savedAt: new Date().toISOString()
            }));
        } catch (error) {
            console.error('[LIFECYCLE] Failed to save events:', error);
        }
    }
    
    function clearEvents() {
        events = [];
        validTransitions = 0;
        errorCount = 0;
        Object.keys(scenarios).forEach(key => {
            scenarios[key].detected = false;
        });
        saveEvents();
        updatePanel();
        logEvent('Log Cleared', 'system');
    }
    
    function exportLogs() {
        const data = {
            exportedAt: new Date().toISOString(),
            storageKey: STORAGE_KEY,
            currentState,
            saveName,
            cityCode,
            validTransitions,
            errorCount,
            scenarios: Object.keys(scenarios).reduce((acc, key) => {
                acc[key] = scenarios[key].detected;
                return acc;
            }, {}),
            events: events.map(e => ({
                timestamp: formatTimestamp(e.timestamp),
                message: e.message,
                type: e.type,
                isError: e.isError,
                state: e.state
            }))
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `lifecycle-log-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
        logEvent('Logs Exported', 'system');
    }
    
    // ============================================================================
    // UI CREATION
    // ============================================================================
    
    function createPanel() {
        // Create container with Tailwind classes
        panel = document.createElement('div');
        panel.id = 'lifecycle-monitor';
        panel.className = 'fixed top-14 left-16 w-[400px] bg-background/95 backdrop-blur-sm border-2 border-border rounded-lg shadow-2xl z-[999999] font-mono text-xs';
        
        // Header
        const header = document.createElement('div');
        header.className = 'px-3 py-2.5 bg-muted border-b border-border flex justify-between items-center cursor-pointer';
        header.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="text-base">🔄</span>
                <span class="font-semibold">Lifecycle Monitor</span>
            </div>
        `;
        
        toggleBtn = document.createElement('button');
        toggleBtn.className = 'text-muted-foreground hover:text-foreground transition-colors';
        toggleBtn.textContent = '▼';
        header.appendChild(toggleBtn);
        
        header.onclick = toggleCollapse;
        
        // Content container
        contentEl = document.createElement('div');
        contentEl.id = 'lifecycle-content';
        contentEl.className = 'max-h-[600px] overflow-hidden transition-all duration-300';
        
        // State info
        const stateInfo = document.createElement('div');
        stateInfo.className = 'px-3 py-2.5 border-b border-border bg-muted/50 space-y-2';
        stateInfo.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="font-medium text-muted-foreground">State:</span>
                <span id="lifecycle-state" class="font-bold text-green-500"></span>
            </div>
            <div class="flex items-center gap-2">
                <span class="font-medium text-muted-foreground">Save:</span>
                <span id="lifecycle-save" class="text-blue-400"></span>
            </div>
            <div id="lifecycle-stats" class="text-xs"></div>
            <div class="pt-2 mt-2 border-t border-border text-[10px] text-muted-foreground">
                Storage: <code class="text-muted-foreground/60">${STORAGE_KEY}</code>
            </div>
        `;
        
        stateEl = stateInfo.querySelector('#lifecycle-state');
        saveNameEl = stateInfo.querySelector('#lifecycle-save');
        statsEl = stateInfo.querySelector('#lifecycle-stats');
        
        // Timeline
        const timelineContainer = document.createElement('div');
        timelineContainer.className = 'px-3 py-2.5 max-h-[300px] overflow-y-auto border-b border-border bg-background/50';
        timelineContainer.innerHTML = `
            <div class="mb-2 font-semibold text-muted-foreground">Timeline (last 20 events):</div>
            <div id="lifecycle-timeline" class="text-[11px] leading-relaxed space-y-1"></div>
        `;
        timelineEl = timelineContainer.querySelector('#lifecycle-timeline');
        
        // Scenarios
        const scenariosContainer = document.createElement('div');
        scenariosContainer.className = 'px-3 py-2.5 border-b border-border bg-muted/50';
        scenariosContainer.innerHTML = `
            <div class="mb-2 font-semibold text-muted-foreground">Scenarios Detected:</div>
            <div id="lifecycle-scenarios" class="text-[11px] leading-relaxed space-y-1"></div>
        `;
        scenariosEl = scenariosContainer.querySelector('#lifecycle-scenarios');
        
        // Buttons
        const buttons = document.createElement('div');
        buttons.className = 'px-3 py-2.5 flex gap-2 flex-wrap';
        
        const clearBtn = document.createElement('button');
        clearBtn.className = 'px-3 py-1.5 bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 transition-colors font-medium';
        clearBtn.textContent = 'Clear Log';
        clearBtn.onclick = () => {
            if (confirm('Clear all lifecycle logs?')) {
                clearEvents();
            }
        };
        
        const exportBtn = document.createElement('button');
        exportBtn.className = 'px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors font-medium';
        exportBtn.textContent = 'Export JSON';
        exportBtn.onclick = exportLogs;
        
        buttons.appendChild(clearBtn);
        buttons.appendChild(exportBtn);
        
        // Assemble panel
        contentEl.appendChild(stateInfo);
        contentEl.appendChild(timelineContainer);
        contentEl.appendChild(scenariosContainer);
        contentEl.appendChild(buttons);
        
        panel.appendChild(header);
        panel.appendChild(contentEl);
        
        document.body.appendChild(panel);
        
        // Initial update
        updatePanel();
    }
    
    function toggleCollapse() {
        isCollapsed = !isCollapsed;
        
        if (isCollapsed) {
            contentEl.style.maxHeight = '0';
            toggleBtn.textContent = '▶';
        } else {
            contentEl.style.maxHeight = '600px';
            toggleBtn.textContent = '▼';
        }
    }
    
    // ============================================================================
    // UI UPDATES
    // ============================================================================
    
    function updatePanel() {
        updateState();
        updateStats();
        updateTimeline();
        updateScenarios();
    }
    
    function updateState() {
        if (stateEl) {
            stateEl.textContent = currentState.toUpperCase().replace(/_/g, ' ');
            stateEl.className = `font-bold ${errorCount > 0 ? 'text-red-500' : 'text-green-500'}`;
        }
        if (saveNameEl) {
            saveNameEl.textContent = saveName || 'None';
        }
    }
    
    function updateStats() {
        if (statsEl) {
            statsEl.innerHTML = `
                <span class="font-medium text-muted-foreground">Transitions:</span>
                <span class="text-green-500">${validTransitions} ✓</span>
                <span class="text-muted-foreground">|</span>
                <span class="font-medium text-muted-foreground">Errors:</span>
                <span class="${errorCount > 0 ? 'text-red-500' : 'text-green-500'}">${errorCount}</span>
            `;
        }
    }
    
    function updateTimeline() {
        if (!timelineEl) return;
        
        const recent = events.slice(-20);
        timelineEl.innerHTML = recent.map(event => {
            let colorClass = 'text-green-500';
            let icon = '⏱️';
            
            if (event.isError) {
                colorClass = 'text-red-500';
                icon = '❌';
            } else if (event.type === 'system') {
                colorClass = 'text-muted-foreground';
                icon = '🔧';
            } else if (event.type === 'api') {
                colorClass = 'text-blue-400';
                icon = '⚙️';
            } else if (event.type === 'transition') {
                colorClass = 'text-purple-400';
                icon = '🔄';
            } else if (event.type === 'user_action') {
                colorClass = 'text-cyan-400';
                icon = '👆';
            }
            
            return `
                <div class="${colorClass}">
                    ${icon} ${formatTimestamp(event.timestamp)} - ${escapeHtml(event.message)}
                </div>
            `;
        }).join('');
    }
    
    function updateScenarios() {
        if (!scenariosEl) return;
        
        scenariosEl.innerHTML = Object.entries(scenarios).map(([key, data]) => {
            const icon = data.detected ? '✓' : '○';
            const colorClass = data.detected ? 'text-green-500' : 'text-muted-foreground/50';
            return `<div class="${colorClass}">${icon} ${data.name}</div>`;
        }).join('');
    }
    
    // ============================================================================
    // UTILS
    // ============================================================================
    
    function formatTimestamp(ms) {
        const seconds = Math.floor(ms / 1000);
        const milliseconds = ms % 1000;
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        
        return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Initialize immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Public API
    return {
        logEvent,
        clearEvents,
        exportLogs,
        getEvents: () => events,
        getCurrentState: () => currentState,
        detectContext
    };
})();



// API Test Suite Mod v1.0.0
// Comprehensive testing framework for Subway Builder Modding API
// Tests hooks, UI components, lifecycle, actions, and known bugs

const APITestSuite = {
    // Test state
    results: {
        passed: 0,
        failed: 0,
        total: 0,
        tests: []
    },
    
    // Test categories
    categories: {
        hooks: { name: 'Lifecycle Hooks', auto: true, tests: [] },
        ui: { name: 'UI Components', auto: false, tests: [] },
        actions: { name: 'Game Actions', auto: false, tests: [] },
        gameState: { name: 'Game State Access', auto: true, tests: [] },
        storage: { name: 'Storage API', auto: false, tests: [] }
    },
    
    // API references
    api: null,
    React: null,
    h: null,
    
    // Test tracking
    hookCallbacks: {
        onGameInit: 0,
        onDayChange: 0,
        onCityLoad: 0,
        onMapReady: 0,
        onRouteCreated: 0,
        onRouteDeleted: 0,
        onPauseChanged: 0,
        onMoneyChanged: 0,
        onStationBuilt: 0,
        onTrainSpawned: 0,
        onGameLoaded: 0
    },
    
    lastDayReceived: null,
    lastCityCode: null,
    mapInstance: null,
    pauseStateChanges: 0,
    moneyTransactions: [],
    
    // Floating panel state tracking (for bug test)
    panelRenderCount: 0,
    panelStateResets: 0,
    panelTestState: null, // Track test state for reset detection
    
    // UI duplicate detection
    panelButtonCount: 0,
    initialButtonCount: null,
    gameLoadCount: 0,
    
    // Multiple hooks test state
    multiHookCounter1: 0,
    multiHookCounter2: 0,
    multiHookTestPending: true,
    
    // Init
    init() {
        if (!window.SubwayBuilderAPI) {
            console.error('[TEST] SubwayBuilderAPI not available');
            return;
        }
        
        this.api = window.SubwayBuilderAPI;
        this.React = this.api.utils.React;
        this.h = this.React.createElement;
        
        console.info('[TEST] === API Test Suite v1.3.0 ===');
        console.info('[TEST] Initializing test framework...');
        
        // Register lifecycle hooks for testing
        this.registerTestHooks();
        
        // Register multiple hooks test
        this.setupMultipleHooksTest();
        
        // Setup UI after game init
        this.api.hooks.onGameInit(() => {
            this.log('Game initialized, setting up test UI...');
            this.setupTestUI();
            
            // Count initial buttons
            setTimeout(() => {
                this.countPanelButtons();
                if (this.initialButtonCount === null) {
                    this.initialButtonCount = this.panelButtonCount;
                }
            }, 500);
            
            // Auto-run passive tests
            setTimeout(() => this.runAutoTests(), 1000);
        });
        
        // Track game loads for duplicate UI bug test
        this.api.hooks.onGameLoaded((saveName) => {
            this.gameLoadCount++;
            this.hookCallbacks.onGameLoaded++;
            
            this.log(`Game loaded: ${saveName} (load #${this.gameLoadCount})`);
            
            // Check for duplicate buttons after load
            setTimeout(() => {
                this.testUIDuplicateOnLoad();
            }, 1000);
        });
    },
    
    // ============================================================================
    // LOGGING & RESULTS
    // ============================================================================
    
    log(message, type = 'info') {
        const prefix = '[TEST]';
        
        if (type === 'pass') {
            console.info(`${prefix} ✓`, message);
        } else if (type === 'fail') {
            console.error(`${prefix} ✗`, message);
        } else {
            console.info(`${prefix}`, message);
        }
    },
    
    recordTest(category, name, passed, details = '', isKnownBug = false) {
        this.results.total++;
        if (passed) {
            this.results.passed++;
        } else {
            this.results.failed++;
        }
        
        const test = {
            category,
            name,
            passed,
            details,
            isKnownBug,
            timestamp: Date.now()
        };
        
        this.results.tests.push(test);
        this.categories[category].tests.push(test);
        
        const icon = passed ? '✓' : '✗';
        const bugLabel = isKnownBug ? ' [KNOWN BUG]' : '';
        this.log(`${icon} ${category.toUpperCase()}: ${name}${bugLabel}`, passed ? 'pass' : 'fail');
        if (details) this.log(`   Details: ${details}`);
        
        // Trigger UI update
        this.updateTestUI();
    },
    
    // ============================================================================
    // DOM INSPECTION UTILITIES
    // ============================================================================
    
    getDOMBudget() {
        try {
            const elem = document.querySelector('#metro-bottom-bar span[title].text-sm.font-medium.mr-auto.font-mono.flex.items-center.gap-2');
            if (!elem) return null;
            
            const text = elem.textContent.trim();
            // Remove $ and commas, parse as number
            const numStr = text.replace(/[$,]/g, '');
            return parseFloat(numStr);
        } catch (error) {
            console.error('[TEST] getDOMBudget error:', error);
            return null;
        }
    },
    
    getDOMDay() {
        try {
            const elem = document.querySelector('#metro-bottom-bar p.font-medium');
            if (!elem) return null;
            
            const text = elem.textContent.trim();
            // Extract number after "Day "
            const match = text.match(/Day (\d+)/);
            return match ? parseInt(match[1]) : null;
        } catch (error) {
            console.error('[TEST] getDOMDay error:', error);
            return null;
        }
    },
    
    getDOMIsPaused() {
        try {
            // If play button exists, game is paused
            const playButton = document.querySelector('#metro-bottom-bar [data-tutorial="play-button"] svg.lucide-play');
            return playButton !== null;
        } catch (error) {
            console.error('[TEST] getDOMIsPaused error:', error);
            return null;
        }
    },
    
    // ============================================================================
    // HOOK REGISTRATION (for tracking callbacks)
    // ============================================================================
    
    setupMultipleHooksTest() {
        // Register two separate hooks that increment different counters
        this.api.hooks.onDayChange(() => {
            this.multiHookCounter1++;
        });
        
        this.api.hooks.onDayChange(() => {
            this.multiHookCounter2++;
        });
        
        // Third hook to perform the actual test
        this.api.hooks.onDayChange(() => {
            if (this.multiHookTestPending && this.multiHookCounter1 > 0 && this.multiHookCounter2 > 0) {
                const bothIncremented = this.multiHookCounter1 === this.multiHookCounter2;
                this.recordTest('hooks', 'Multiple hook registrations independent', bothIncremented,
                    `Counter1: ${this.multiHookCounter1}, Counter2: ${this.multiHookCounter2}`);
                this.multiHookTestPending = false;
            }
        });
    },
    
    registerTestHooks() {
        // onGameInit
        this.api.hooks.onGameInit(() => {
            this.hookCallbacks.onGameInit++;
            this.recordTest('hooks', 'onGameInit triggered', true, 
                `Called ${this.hookCallbacks.onGameInit} time(s)`);
        });
        
        // onDayChange
        this.api.hooks.onDayChange((day) => {
            this.hookCallbacks.onDayChange++;
            this.lastDayReceived = day;
            this.recordTest('hooks', 'onDayChange triggered', true, 
                `Day ${day}, callback count: ${this.hookCallbacks.onDayChange}`);
        });
        
        // onCityLoad
        this.api.hooks.onCityLoad((cityCode) => {
            this.hookCallbacks.onCityLoad++;
            this.lastCityCode = cityCode;
            this.recordTest('hooks', 'onCityLoad triggered', true, 
                `City: ${cityCode}`);
        });
        
        // onMapReady
        this.api.hooks.onMapReady((map) => {
            this.hookCallbacks.onMapReady++;
            this.mapInstance = map;
            const isValid = map && typeof map.getZoom === 'function';
            this.recordTest('hooks', 'onMapReady provides valid map', isValid, 
                `Map instance: ${typeof map}, has getZoom: ${!!map?.getZoom}`);
        });
        
        // onRouteCreated
        this.api.hooks.onRouteCreated((route) => {
            this.hookCallbacks.onRouteCreated++;
            const hasRequiredProps = route && route.id && route.bullet;
            this.recordTest('hooks', 'onRouteCreated triggered', hasRequiredProps, 
                `Route: ${route?.bullet || 'unknown'}, ID: ${route?.id}`);
        });
        
        // onRouteDeleted
        this.api.hooks.onRouteDeleted((routeId, routeBullet) => {
            this.hookCallbacks.onRouteDeleted++;
            this.recordTest('hooks', 'onRouteDeleted triggered', true, 
                `Route: ${routeBullet}, ID: ${routeId}`);
        });
        
        // onPauseChanged
        this.api.hooks.onPauseChanged((isPaused) => {
            this.hookCallbacks.onPauseChanged++;
            this.pauseStateChanges++;
            this.recordTest('hooks', 'onPauseChanged triggered', true, 
                `State: ${isPaused ? 'paused' : 'running'}, changes: ${this.pauseStateChanges}`);
        });
        
        // onMoneyChanged
        this.api.hooks.onMoneyChanged((balance, change, type, category) => {
            this.hookCallbacks.onMoneyChanged++;
            this.moneyTransactions.push({ balance, change, type, category, time: Date.now() });
            if (this.hookCallbacks.onMoneyChanged <= 3) { // Only log first 3 to avoid spam
                this.recordTest('hooks', 'onMoneyChanged triggered', true, 
                    `${type}: $${Math.abs(change)}, new balance: $${balance}`);
            }
        });
        
        // onStationBuilt
        this.api.hooks.onStationBuilt((station) => {
            this.hookCallbacks.onStationBuilt++;
            this.recordTest('hooks', 'onStationBuilt triggered', true, 
                `Station: ${station?.name || 'unnamed'}`);
        });
        
        // onTrainSpawned
        this.api.hooks.onTrainSpawned((train) => {
            this.hookCallbacks.onTrainSpawned++;
            if (this.hookCallbacks.onTrainSpawned <= 2) { // Limit spam
                this.recordTest('hooks', 'onTrainSpawned triggered', true, 
                    `Train ID: ${train?.id}, Route: ${train?.routeId}`);
            }
        });
    },
    
    // ============================================================================
    // AUTO TESTS (passive monitoring)
    // ============================================================================
    
    runAutoTests() {
        this.log('Running auto tests...');
        
        // Test: Game State Access
        this.testGameStateAccess();
        
        // Test: DOM vs API consistency
        setTimeout(() => this.testDOMAPIConsistency(), 2000);
    },
    
    testGameStateAccess() {
        try {
            const routes = this.api.gameState.getRoutes();
            const stations = this.api.gameState.getStations();
            const trains = this.api.gameState.getTrains();
            const budget = this.api.gameState.getBudget();
            const day = this.api.gameState.getCurrentDay();
            const isPaused = this.api.gameState.isPaused();
            
            this.recordTest('gameState', 'getRoutes() returns array', Array.isArray(routes),
                `Found ${routes.length} routes`);
            this.recordTest('gameState', 'getStations() returns array', Array.isArray(stations),
                `Found ${stations.length} stations`);
            this.recordTest('gameState', 'getTrains() returns array', Array.isArray(trains),
                `Found ${trains.length} trains`);
            this.recordTest('gameState', 'getBudget() returns number', typeof budget === 'number',
                `Budget: $${budget?.toLocaleString()}`);
            this.recordTest('gameState', 'getCurrentDay() returns number', typeof day === 'number',
                `Current day: ${day}`);
            this.recordTest('gameState', 'isPaused() returns boolean', typeof isPaused === 'boolean',
                `Game is ${isPaused ? 'paused' : 'running'}`);
            
            // Test getLineMetrics
            const metrics = this.api.gameState.getLineMetrics();
            this.recordTest('gameState', 'getLineMetrics() returns array', Array.isArray(metrics),
                `Found ${metrics.length} line metrics`);
                
        } catch (error) {
            this.recordTest('gameState', 'Game state access', false, error.message);
        }
    },
    
    testDOMAPIConsistency() {
        this.log('Testing DOM vs API consistency...');
        
        // Budget
        const apiBudget = this.api.gameState.getBudget();
        const domBudget = this.getDOMBudget();
        
        if (domBudget !== null) {
            const budgetMatch = Math.floor(apiBudget) === Math.floor(domBudget);
            this.recordTest('gameState', 'API budget matches DOM display', budgetMatch,
                `API: $${Math.floor(apiBudget)}, DOM: $${Math.floor(domBudget)}`);
        } else {
            this.recordTest('gameState', 'API budget matches DOM display', false,
                'Could not read budget from DOM');
        }
        
        // Day
        const apiDay = this.api.gameState.getCurrentDay();
        const domDay = this.getDOMDay();
        
        if (domDay !== null) {
            const dayMatch = apiDay === domDay;
            this.recordTest('gameState', 'API day matches DOM display', dayMatch,
                `API: Day ${apiDay}, DOM: Day ${domDay}`);
        } else {
            this.recordTest('gameState', 'API day matches DOM display', false,
                'Could not read day from DOM');
        }
        
        // Pause state
        const apiPaused = this.api.gameState.isPaused();
        const domPaused = this.getDOMIsPaused();
        
        if (domPaused !== null) {
            const pauseMatch = apiPaused === domPaused;
            this.recordTest('gameState', 'API pause state matches DOM display', pauseMatch,
                `API: ${apiPaused ? 'paused' : 'running'}, DOM: ${domPaused ? 'paused' : 'running'}`);
        } else {
            this.recordTest('gameState', 'API pause state matches DOM display', false,
                'Could not read pause state from DOM');
        }
    },
    
    // ============================================================================
    // MANUAL TESTS (require user interaction)
    // ============================================================================
    
    countPanelButtons() {
        // Count buttons that trigger the api-test-suite panel
        const buttons = document.querySelectorAll('[data-panel-id="api-test-suite"]');
        this.panelButtonCount = buttons.length;
        this.log(`Panel button count: ${this.panelButtonCount}`);
    },
    
    testUIDuplicateOnLoad() {
        this.countPanelButtons();
        
        const noDuplicates = this.panelButtonCount === this.initialButtonCount;
        const details = `Expected: ${this.initialButtonCount}, Found: ${this.panelButtonCount} (after ${this.gameLoadCount} loads)`;
        
        this.recordTest('ui', 'No duplicate panel buttons on game load', noDuplicates, details, !noDuplicates);
    },
    
    testFloatingPanelStateReset() {
        this.log('Testing floating panel state reset...');
        
        // Record current render count
        const beforeCount = this.panelRenderCount;
        
        this.recordTest('ui', 'floatingPanel state persistence test started', true,
            `Current render count: ${beforeCount}. Now drag/resize the panel and click "Check Panel State" button.`);
    },
    
    checkFloatingPanelState() {
        const afterCount = this.panelRenderCount;
        
        // We expect the panel to re-render on drag/resize (known bug)
        const actuallyReset = afterCount > this.panelRenderCount;
        
        this.recordTest('ui', 'floatingPanel preserves state on drag/resize', actuallyReset,
            `Render count increased from panel creation, indicating state reset on interaction`, true);
    },
    
    testReloadMods() {
        this.log('Testing reloadMods()...');
        
        const beforeCallbacks = { ...this.hookCallbacks };
        const beforeRenderCount = this.panelRenderCount;
        
        this.recordTest('ui', 'reloadMods() test started', true,
            `Current state - Hook callbacks: ${Object.values(beforeCallbacks).reduce((a,b) => a+b, 0)}, Render count: ${beforeRenderCount}`);
        
        // Call reloadMods
        this.api.reloadMods()
            .then(() => {
                setTimeout(() => {
                    const afterCallbacks = { ...this.hookCallbacks };
                    const afterRenderCount = this.panelRenderCount;
                    
                    // After reload, hooks should be reset and component should be destroyed/recreated
                    const hooksReset = Object.values(afterCallbacks).every(count => count === 0);
                    const componentRecreated = afterRenderCount === 0 || afterRenderCount < beforeRenderCount;
                    
                    this.recordTest('ui', 'reloadMods() resets hook callbacks', hooksReset,
                        `Before: ${Object.values(beforeCallbacks).reduce((a,b) => a+b, 0)}, After: ${Object.values(afterCallbacks).reduce((a,b) => a+b, 0)}`, !hooksReset);
                    
                    this.recordTest('ui', 'reloadMods() destroys and recreates component', componentRecreated,
                        `Render count before: ${beforeRenderCount}, after: ${afterRenderCount}`, !componentRecreated);
                }, 1000);
            })
            .catch(error => {
                this.recordTest('ui', 'reloadMods() execution', false, error.message);
            });
    },
    
    testActions() {
        this.log('Testing game actions...');
        
        // Test: setPause (outside hooks)
        try {
            const wasPaused = this.api.gameState.isPaused();
            this.api.actions.setPause(true);
            setTimeout(() => {
                const isNowPaused = this.api.gameState.isPaused();
                this.recordTest('actions', 'setPause(true) works outside hooks', isNowPaused,
                    `Was paused: ${wasPaused}, now paused: ${isNowPaused}`);
                // Restore state
                this.api.actions.setPause(wasPaused);
            }, 500);
        } catch (error) {
            this.recordTest('actions', 'setPause', false, error.message);
        }
        
        // Test: setPause inside onDayChange (known bug)
        let pauseWorkedInHook = false;
        const unhook = this.api.hooks.onDayChange(() => {
            try {
                this.api.actions.setPause(true);
                setTimeout(() => {
                    const isPaused = this.api.gameState.isPaused();
                    pauseWorkedInHook = isPaused;
                    
                    this.recordTest('actions', 'setPause works inside onDayChange', pauseWorkedInHook,
                        `setPause called in hook, paused: ${isPaused}`, !pauseWorkedInHook);
                    
                    // Restore and cleanup
                    this.api.actions.setPause(false);
                    if (unhook) unhook();
                }, 100);
            } catch (error) {
                this.recordTest('actions', 'setPause in hook', false, error.message, true);
            }
        });
        
        // Test: setSpeed
        try {
            const originalSpeed = this.api.gameState.getGameSpeed();
            this.api.actions.setSpeed('fast');
            setTimeout(() => {
                const newSpeed = this.api.gameState.getGameSpeed();
                this.recordTest('actions', 'setSpeed() changes speed', newSpeed === 'fast',
                    `Original: ${originalSpeed}, new: ${newSpeed}`);
                // Restore
                this.api.actions.setSpeed(originalSpeed);
            }, 500);
        } catch (error) {
            this.recordTest('actions', 'setSpeed', false, error.message);
        }
        
        // Test: setMoney
        try {
            const originalBudget = this.api.gameState.getBudget();
            const testAmount = 999999999;
            this.api.actions.setMoney(testAmount);
            setTimeout(() => {
                const newBudget = this.api.gameState.getBudget();
                this.recordTest('actions', 'setMoney() updates budget', newBudget === testAmount,
                    `Set to: ${testAmount}, actual: ${newBudget}`);
                // Restore
                this.api.actions.setMoney(originalBudget);
            }, 500);
        } catch (error) {
            this.recordTest('actions', 'setMoney', false, error.message);
        }
    },
    
    testStorage() {
        this.log('Testing storage API...');
        
        // Test: set and get
        const testKey = 'test-key-' + Date.now();
        const testValue = { foo: 'bar', number: 42 };
        
        this.api.storage.set(testKey, testValue)
            .then(() => {
                return this.api.storage.get(testKey);
            })
            .then(retrieved => {
                const matches = JSON.stringify(retrieved) === JSON.stringify(testValue);
                this.recordTest('storage', 'set() and get() work', matches,
                    `Stored and retrieved: ${JSON.stringify(retrieved)}`);
                
                // Only test delete if set/get succeeded
                if (matches) {
                    return this.api.storage.delete(testKey);
                } else {
                    throw new Error('set/get failed, skipping delete test');
                }
            })
            .then(() => {
                return this.api.storage.get(testKey);
            })
            .then(afterDelete => {
                this.recordTest('storage', 'delete() removes value', afterDelete === undefined,
                    `Value after delete: ${afterDelete}`);
            })
            .catch(error => {
                this.recordTest('storage', 'Storage operations', false, error.message);
            });
    },
    
    // ============================================================================
    // UI SETUP
    // ============================================================================
    
    setupTestUI() {
        this.api.ui.addFloatingPanel({
            id: 'api-test-suite',
            title: 'API Test Suite',
            icon: 'ShieldCheck',
            width: 600,
            height: 800,
            render: () => this.renderTestPanel()
        });
        
        this.log('Test UI panel created');
    },
    
    updateTestUI() {
        // Force React update by incrementing a counter
        if (this._forceUpdate) {
            this._forceUpdate();
        }
    },
    
    renderTestPanel() {
        const h = this.h;
        const self = this;
        
        const TestPanel = () => {
            const [, forceUpdate] = this.React.useReducer(x => x + 1, 0);
            
            // Store force update function for external triggers
            this.React.useEffect(() => {
                self._forceUpdate = forceUpdate;
            }, []);
            
            // Track render count for bug testing
            this.React.useEffect(() => {
                self.panelRenderCount++;
            });
            
            const { passed, failed, total, tests } = self.results;
            const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;
            
            // Check if multiple hooks test is pending
            const multiHookTestResult = tests.find(t => t.name === 'Multiple hook registrations independent');
            const multiHookPending = self.multiHookTestPending && !multiHookTestResult;
            
            return h('div', { className: 'flex flex-col h-full' }, [
                // Stats header
                h('div', { 
                    key: 'stats',
                    className: 'px-4 py-3 border-b border-border bg-muted/30'
                }, [
                    h('div', { 
                        key: 'summary',
                        className: 'flex justify-between items-center mb-2'
                    }, [
                        h('span', { key: 'total', className: 'font-semibold' }, 
                            `Tests: ${total}`),
                        h('span', { key: 'rate', className: 'text-sm' }, 
                            `Pass Rate: ${passRate}%`)
                    ]),
                    h('div', { 
                        key: 'counts',
                        className: 'flex gap-4 text-sm'
                    }, [
                        h('span', { key: 'passed', className: 'text-green-600 dark:text-green-400' }, 
                            `✓ Passed: ${passed}`),
                        h('span', { key: 'failed', className: 'text-red-600 dark:text-red-400' }, 
                            `✗ Failed: ${failed}`)
                    ]),
                    multiHookPending && h('div', {
                        key: 'pending',
                        className: 'mt-2 text-xs text-yellow-600 dark:text-yellow-400'
                    }, '⏳ Waiting for next day change to verify multiple hook registrations...')
                ]),
                
                // Action buttons
                h('div', {
                    key: 'actions',
                    className: 'px-4 py-2 border-b border-border flex gap-2 flex-wrap'
                }, [
                    h('button', {
                        key: 'actions',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testActions()
                    }, 'Test Actions'),
                    h('button', {
                        key: 'storage',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testStorage()
                    }, 'Test Storage'),
                    h('button', {
                        key: 'dom',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testDOMAPIConsistency()
                    }, 'Test DOM/API Consistency'),
                    h('button', {
                        key: 'panel-check',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.checkFloatingPanelState()
                    }, 'Check Panel State'),
                    h('button', {
                        key: 'reload',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testReloadMods()
                    }, 'Test reloadMods()'),
                    h('button', {
                        key: 'clear',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80',
                        onClick: () => {
                            self.results = { passed: 0, failed: 0, total: 0, tests: [] };
                            Object.keys(self.categories).forEach(cat => {
                                self.categories[cat].tests = [];
                            });
                            self.multiHookTestPending = true;
                            forceUpdate();
                        }
                    }, 'Clear Results')
                ]),
                
                // Test results
                h('div', {
                    key: 'results',
                    className: 'flex-1 overflow-auto px-4 py-2'
                }, 
                    tests.length === 0 
                        ? h('div', { className: 'text-sm text-muted-foreground text-center py-8' },
                            'No tests run yet. Auto tests will run shortly after game init.')
                        : Object.entries(self.categories).map(([catKey, cat]) => {
                            if (cat.tests.length === 0) return null;
                            
                            return h('div', { 
                                key: catKey,
                                className: 'mb-4'
                            }, [
                                h('div', {
                                    key: 'header',
                                    className: 'font-semibold text-sm mb-2 flex items-center gap-2'
                                }, [
                                    h('span', { key: 'name' }, cat.name),
                                    h('span', { 
                                        key: 'count',
                                        className: 'text-xs text-muted-foreground'
                                    }, `(${cat.tests.length})`)
                                ]),
                                h('div', {
                                    key: 'tests',
                                    className: 'space-y-1'
                                }, cat.tests.map((test, idx) => 
                                    h('div', {
                                        key: idx,
                                        className: `text-xs p-2 rounded-md ${
                                            test.passed 
                                                ? 'bg-green-500/10 border border-green-500/20' 
                                                : 'bg-red-500/20 border-2 border-red-500'
                                        }`
                                    }, [
                                        h('div', { 
                                            key: 'name',
                                            className: 'font-medium'
                                        }, [
                                            h('span', { key: 'icon' }, test.passed ? '✓ ' : '✗ '),
                                            h('span', { key: 'text' }, test.name),
                                            test.isKnownBug && h('span', {
                                                key: 'known',
                                                className: 'ml-2 px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-600 dark:text-orange-400 border border-orange-500/30'
                                            }, 'KNOWN BUG')
                                        ]),
                                        test.details && h('div', {
                                            key: 'details',
                                            className: 'text-muted-foreground mt-1'
                                        }, test.details)
                                    ])
                                ))
                            ]);
                        })
                ),
                
                // Debug info
                h('div', {
                    key: 'debug',
                    className: 'px-4 py-2 border-t border-border text-xs text-muted-foreground space-y-1'
                }, [
                    h('div', { key: 'render' }, `Panel renders: ${self.panelRenderCount}`),
                    h('div', { key: 'hooks' }, `Hook callbacks: ${Object.values(self.hookCallbacks).reduce((a, b) => a + b, 0)}`),
                    h('div', { key: 'loads' }, `Game loads: ${self.gameLoadCount}`),
                    h('div', { key: 'buttons' }, `Panel buttons in DOM: ${self.panelButtonCount}`),
                    h('div', { key: 'multi' }, `Multi-hook counters: ${self.multiHookCounter1} / ${self.multiHookCounter2}`)
                ])
            ]);
        };
        
        return h(TestPanel);
    }
};

// Initialize API Test Suite
if (window.SubwayBuilderAPI) {
    APITestSuite.init();
} else {
    const checkAPI = setInterval(() => {
        if (window.SubwayBuilderAPI) {
            clearInterval(checkAPI);
            APITestSuite.init();
        }
    }, 100);
}

// Expose both for console access
window.LifecycleMonitor = LifecycleMonitor;
window.APITestSuite = APITestSuite;