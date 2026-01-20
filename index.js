// ============================================================================
// LIFECYCLE MONITOR (Vanilla JS - Loads First)
// ============================================================================

const LifecycleMonitor = (function() {
    'use strict';
    
    const STORAGE_KEY = 'LifecycleMonitor_Events';
    const MAX_EVENTS = 200;
    
    // State machine
    const STATES = {
        UNINITIALIZED: 'uninitialized',
        API_READY: 'api_ready',
        CITY_LOADING: 'city_loading',
        GAME_INIT: 'game_init',
        IN_GAME: 'in_game',
        MENU: 'menu'
    };
    
    const VALID_TRANSITIONS = {
        [STATES.UNINITIALIZED]: [STATES.API_READY],
        [STATES.API_READY]: [STATES.CITY_LOADING, STATES.GAME_INIT],
        [STATES.CITY_LOADING]: [STATES.GAME_INIT, STATES.IN_GAME],
        [STATES.GAME_INIT]: [STATES.IN_GAME],
        [STATES.IN_GAME]: [STATES.MENU, STATES.CITY_LOADING],
        [STATES.MENU]: [STATES.CITY_LOADING, STATES.GAME_INIT]
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
    let currentContext = 'unknown'; // 'main_menu' | 'in_game' | 'load_save_screen'
    let pendingLoad = null; // { saveName: string, timestamp: number, context: string }
    
    // Hook call counters
    let gameInitCount = 0;
    let cityLoadCount = 0;
    let mapReadyCount = 0;
    let onDemandChangeCount = 0;
    let onDemandChangeBeforeGame = 0;
    let onDemandChangeDuringGame = 0;
    
    // Scenario tracking
    const scenarios = {
        'new_game_from_menu': { detected: false, name: 'New Game from Menu' },
        'load_save_from_menu': { detected: false, name: 'Load Save from Menu' },
        'game_load_different_save': { detected: false, name: 'In Game → Load Different Save'},
        'game_reload_same_save': { detected: false, name: 'In Game → Reload Same Save' },
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
        
        // Setup DOM observers and listeners
        setupContextObserver();
        setupDOMListeners();
        
        // Wait for API
        const checkAPI = setInterval(() => {
            if (window.SubwayBuilderAPI) {
                clearInterval(checkAPI);
                onAPIReady();
            }
        }, 10);
        
        console.info('[LIFECYCLE] Monitor initialized');
    }
    
    function onAPIReady() {
        logEvent('API Available', 'api');
        transitionState(STATES.API_READY);
        
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
            if (currentState === STATES.CITY_LOADING || currentState === STATES.API_READY) {
                transitionState(STATES.GAME_INIT);
                detectScenario('game_init');
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
            if (currentState === STATES.API_READY || currentState === STATES.MENU) {
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
            const oldSaveName = saveName;
            saveName = name;
            
            // Check if this matches a pending load
            if (pendingLoad && pendingLoad.saveName === name) {
                const elapsed = Date.now() - pendingLoad.timestamp;
                logEvent(`Load completed: "${name}" (${elapsed}ms from ${pendingLoad.context})`, 'lifecycle');
                
                // Detect scenario based on context of load
                if (pendingLoad.context === 'main_menu') {
                    detectScenario('load_from_menu');
                } else if (pendingLoad.context === 'in_game_menu') {
                    if (wasSameSave) {
                        detectScenario('reload_same_save');
                    } else {
                        detectScenario('load_different_save');
                    }
                }
                
                pendingLoad = null; // Clear pending
            } else {
                logEvent(`Game Loaded: ${name}${wasSameSave ? ' (SAME)' : ''}`, 'lifecycle');
            }
            
            updatePanel();
        });
        
        api.hooks.onGameSaved((name) => {
            logEvent(`Game Saved: ${name}`, 'lifecycle');
        });
        
        // Track onDemandChange calls
        api.hooks.onDemandChange((popCount) => {
            onDemandChangeCount++;
            const inGame = currentState === STATES.IN_GAME;
            
            if (inGame) {
                onDemandChangeDuringGame++;
            } else {
                onDemandChangeBeforeGame++;
            }
            
            logEvent(`onDemandChange fired (call #${onDemandChangeCount}, ${inGame ? 'in-game' : 'before game'}, ${popCount} pops)`, 'lifecycle');
            
            // Test: Should fire during game, but doesn't (known bug)
            if (onDemandChangeBeforeGame >= 2 && onDemandChangeDuringGame === 0 && inGame) {
                logEvent(`onDemandChange bug detected: Fired ${onDemandChangeBeforeGame}x before game, 0x during gameplay`, 'error', true);
                errorCount++;
                updateStats();
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
            context: currentContext,
            time: new Date().toISOString()
        };
        
        events.push(event);
        
        // Trim to max events
        if (events.length > MAX_EVENTS) {
            events = events.slice(-MAX_EVENTS);
        }
        
        saveEvents();
        updateTimeline();
        
        const icon = isError ? '❌' : type === 'system' ? '🔧' : type === 'api' ? '⚙️' : type === 'user_action' ? '👆' : type === 'context' ? '🔄' : '🎮';
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

        
        // NEW GAME: User clicked New Game → Game Init → Save is "NONE"
        if (trigger === 'game_init') {
            if (!events || !Array.isArray(events)) {
                return null;
            }
            
            const recent = events.slice(-10);
            const hasNewGameClick = recent.some(e => 
                e.type === 'user_action' && e.message === 'User clicked: New Game'
            );

            const currentSave = window.SubwayBuilderAPI.gameState.getCurrentSaveName?.() || 'NONE';
            if (hasNewGameClick && currentSave === 'NONE') {
                scenarios.new_game_from_menu.detected = true;
            }
        }
        
        // Load Save from Menu (main menu context)
        if (trigger === 'load_from_menu') {
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
    // DOM OBSERVATION & INTERACTION
    // ============================================================================
    
    function setupContextObserver() {
        const observer = new MutationObserver(() => {
            detectContext();
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        
        // Initial detection
        detectContext();
    }
    
    function detectContext() {
        const oldContext = currentContext;
        
        if (document.querySelector('main.grid.gap-8.min-h-screen')) {
            currentContext = 'load_save_screen';
        } else if (document.querySelector('main.justify-center')) {
            currentContext = 'main_menu';
        } else if (document.querySelector('div[data-mod-id="escape-menu"]')) {
            currentContext = 'in_game_menu';
        } else if (document.querySelector('div[data-mod-id="top-bar"]')) {
            currentContext = 'in_game';
        } else {
            currentContext = 'unknown';
        }
        
        if (oldContext !== currentContext && oldContext !== 'unknown') {
            logEvent(`Context: ${oldContext} → ${currentContext}`, 'context');
        }
    }
    
    function setupDOMListeners() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            
            // Check if click is inside in-game menu
            const inSaveMenu = target.closest('[data-mod-id="save-menu"]');
            
            // Load Button Click (in save blocks)
            if (target.closest('button')?.textContent.includes('Load')) {
                const saveBlock = target.closest('.relative.panel-blur');
                if (saveBlock) {
                    const saveNameEl = saveBlock.querySelector('.text-base.font-black');
                    const saveName = saveNameEl?.textContent || 'unknown';
                    
                    logEvent(`User clicked: Load "${saveName}" (from ${currentContext})`, 'user_action');
                    
                    // Track pending load
                    pendingLoad = {
                        saveName,
                        timestamp: Date.now(),
                        context: inSaveMenu ? 'in_game_menu' : 'main_menu'
                    };

                    logEvent(`...waiting for "${saveName}" to load`, 'system');
                }
            }
            
            // New Game Click
            else if (target.closest('main.justify-center') && 
                target.textContent.includes('New Game')) {
                logEvent('User clicked: New Game', 'user_action');
            }
            
            // Save Button Click (inside save menu)
            else if (target.closest('button')?.textContent.includes('Save') &&
                target.closest('[data-mod-id="save-menu"]')) {
                const input = document.querySelector('[data-mod-id="save-menu"] input[placeholder="Enter save name..."]');
                const saveName = input?.value || 'unnamed';
                logEvent(`User clicked: Save "${saveName}"`, 'user_action');
            }
            
            // Load/Save Menu Open (only if not in save menu already)
            else if (target.textContent.includes('Load/Save') && !inSaveMenu) {
                const from = currentContext === 'main_menu' ? 'Main Menu' : 'In-Game';
                logEvent(`User clicked: Load/Save (from ${from})`, 'user_action');
            }
            
            // Menu Toggle
            else if (target.closest('.lucide-menu')) {
                logEvent('User clicked: Menu toggle', 'user_action');
            }
        }, true);
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
        gameInitCount = 0;
        cityLoadCount = 0;
        mapReadyCount = 0;
        onDemandChangeCount = 0;
        onDemandChangeBeforeGame = 0;
        onDemandChangeDuringGame = 0;
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
            currentContext,
            saveName,
            cityCode,
            validTransitions,
            errorCount,
            hookCalls: {
                gameInit: gameInitCount,
                cityLoad: cityLoadCount,
                mapReady: mapReadyCount,
                onDemandChange: onDemandChangeCount,
                onDemandChangeBeforeGame,
                onDemandChangeDuringGame
            },
            scenarios: Object.keys(scenarios).reduce((acc, key) => {
                acc[key] = scenarios[key].detected;
                return acc;
            }, {}),
            events: events.map(e => ({
                timestamp: formatTimestamp(e.timestamp),
                message: e.message,
                type: e.type,
                isError: e.isError,
                state: e.state,
                context: e.context
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
        header.className = 'px-3 py-3 bg-muted border-b border-border flex justify-between items-center cursor-pointer';
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
        stateInfo.className = 'px-3 py-3 border-b border-border bg-muted/50 space-y-2';
        stateInfo.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="font-medium text-muted-foreground">State:</span>
                <span id="lifecycle-state" class="font-bold text-green-500"></span>
            </div>
            <div class="flex items-center gap-2">
                <span class="font-medium text-muted-foreground">Context:</span>
                <span id="lifecycle-context" class="text-purple-400"></span>
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
        const contextEl = stateInfo.querySelector('#lifecycle-context');
        saveNameEl = stateInfo.querySelector('#lifecycle-save');
        statsEl = stateInfo.querySelector('#lifecycle-stats');
        
        // Update context display
        const updateContextDisplay = () => {
            if (contextEl) {
                contextEl.textContent = currentContext.toUpperCase().replace('_', ' ');
            }
        };
        setInterval(updateContextDisplay, 500);
        
        // Timeline
        const timelineContainer = document.createElement('div');
        timelineContainer.className = 'px-3 py-3 max-h-[300px] overflow-y-auto border-b border-border bg-background/50';
        timelineContainer.innerHTML = `
            <div class="mb-2 font-semibold text-muted-foreground">Timeline (last 50 events):</div>
            <div id="lifecycle-timeline" class="text-[11px] leading-relaxed space-y-1"></div>
        `;
        timelineEl = timelineContainer.querySelector('#lifecycle-timeline');

        console.log(pendingLoad)

        const loadAlert = document.createElement('div');
        loadAlert.id = 'lifecycle-load-alert'
        loadAlert.className = 'mx-3 my-3 p-3 bg-pink-500 rounded hidden';
        loadAlert.innerHTML = 'Loading...';
        
        // Scenarios
        const scenariosContainer = document.createElement('div');
        scenariosContainer.className = 'px-3 py-3 border-b border-border bg-muted/50';
        scenariosContainer.innerHTML = `
            <div class="mb-2 font-semibold text-muted-foreground">Scenarios Detected:</div>
            <div id="lifecycle-scenarios" class="text-[11px] leading-relaxed space-y-1"></div>
        `;
        scenariosEl = scenariosContainer.querySelector('#lifecycle-scenarios');
        
        // Buttons
        const buttons = document.createElement('div');
        buttons.className = 'px-3 py-3 flex gap-2 flex-wrap';
        
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
        contentEl.appendChild(loadAlert);
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
            stateEl.textContent = currentState.toUpperCase();
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
        
        const recent = events.slice(-50);
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
                colorClass = 'text-yellow-400';
                icon = '👆';
            } else if (event.type === 'context') {
                colorClass = 'text-cyan-400';
                icon = '📍';
            } else if (event.type === 'lifecycle') {
                icon = '⚡';
            }
            
            return `
                <div class="${colorClass}">
                    ${icon} ${formatTimestamp(event.timestamp)} - ${escapeHtml(event.message)}
                </div>
            `;
        }).join('');
        timelineEl.parentElement.scroll(0,2000);
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
        getHookCalls: () => ({
            gameInit: gameInitCount,
            cityLoad: cityLoadCount,
            mapReady: mapReadyCount,
            onDemandChange: onDemandChangeCount
        })
    };
})();

// ============================================================================
// API TEST SUITE (React-based - Loads After API Ready)
// ============================================================================

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
        actions: { name: 'Game Actions', auto: false, tests: [] },
        gameState: { name: 'Game State Access', auto: true, tests: [] },
        storage: { name: 'Storage API', auto: false, tests: [] },
        modifyConstants: { name: 'Modify Constants', auto: false, tests: [] }
    },
    
    // API references
    api: null,
    React: null,
    h: null,
    
    // Floating panel state tracking
    panelRenderCount: 0,
    
    // Speed test progress tracking
    speedTestProgress: [],
    
    // Init
    init() {
        if (!window.SubwayBuilderAPI) {
            console.error('[TEST] SubwayBuilderAPI not available');
            return;
        }
        
        this.api = window.SubwayBuilderAPI;
        this.React = this.api.utils.React;
        this.h = this.React.createElement;
        
        console.info('[TEST] === API Test Suite v2.0.1 ===');
        console.info('[TEST] Initializing test framework...');
        
        // Setup UI after game init
        this.api.hooks.onGameInit(() => {
            this.log('Game initialized, setting up test UI...');
            this.setupTestUI();
            
            // Auto-run passive tests
            setTimeout(() => this.runAutoTests(), 1000);
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
    
    recordTest(category, name, passed, details = '') {
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
            timestamp: Date.now()
        };
        
        this.results.tests.push(test);
        this.categories[category].tests.push(test);
        
        const icon = passed ? '✓' : '✗';
        this.log(`${icon} ${category.toUpperCase()}: ${name}`, passed ? 'pass' : 'fail');
        if (details) this.log(`   Details: ${details}`);
        
        // Trigger UI update
        this.updateTestUI();
    },
    
    addSpeedTestStep(step, passed, details = '') {
        this.speedTestProgress.push({ step, passed, details, timestamp: Date.now() });
        this.updateTestUI();
    },
    
    clearSpeedTestProgress() {
        this.speedTestProgress = [];
        this.updateTestUI();
    },
    
    // ============================================================================
    // DOM INSPECTION UTILITIES
    // ============================================================================
    
    getDOMBudget() {
        try {
            const elem = document.querySelector('[data-mod-id="money-value"]');
            if (!elem) return null;
            
            const text = elem.textContent.trim();
            const numStr = text.replace(/[$,]/g, '');
            return parseFloat(numStr);
        } catch (error) {
            console.error('[TEST] getDOMBudget error:', error);
            return null;
        }
    },
    
    getDOMDay() {
        try {
            const elem = document.querySelector('[data-mod-id="day-display"]');
            if (!elem) return null;
            
            const text = elem.textContent.trim();
            const match = text.match(/Day (\d+)/);
            return match ? parseInt(match[1]) : null;
        } catch (error) {
            console.error('[TEST] getDOMDay error:', error);
            return null;
        }
    },
    
    getDOMIsPaused() {
        try {
            const playButton = document.querySelector('#metro-bottom-bar [data-tutorial="play-button"] svg.lucide-play');
            return playButton !== null;
        } catch (error) {
            console.error('[TEST] getDOMIsPaused error:', error);
            return null;
        }
    },
    
    getInGameTime() {
        try {
            const timeEl = document.querySelector('div[data-mod-id="clock"] p.font-mono');
            console.info(">>>>>> " + timeEl);
            if (!timeEl) return null;
            
            const match = timeEl.textContent.match(/(\d+):(\d+):(\d+)/);
            console.info(">>>>>> " + match);
            if (!match) return null;
            
            const hours = parseInt(match[1]);
            const minutes = parseInt(match[2]);
            const seconds = parseInt(match[3]);

            console.info(">>>>>> " +  hours * 3600 + minutes * 60 + seconds);
            
            return hours * 3600 + minutes * 60 + seconds;
        } catch (error) {
            console.error('[TEST] getInGameTime error:', error);
            return null;
        }
    },
    
    // ============================================================================
    // AUTO TESTS (passive monitoring)
    // ============================================================================
    
    runAutoTests() {
        this.log('Running auto tests...');
        this.testGameStateAccess();
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
            
            const metrics = this.api.gameState.getLineMetrics();
            this.recordTest('gameState', 'getLineMetrics() returns array', Array.isArray(metrics),
                `Found ${metrics.length} line metrics`);
                
        } catch (error) {
            this.recordTest('gameState', 'Game state access', false, error.message);
        }
    },
    
    testDOMAPIConsistency() {
        this.log('Testing DOM vs API consistency...');
        
        // Budget (rounded in UI)
        const apiBudget = this.api.gameState.getBudget();
        const domBudget = this.getDOMBudget();
        
        if (domBudget !== null) {
            const apiRounded = Math.round(apiBudget);
            const domRounded = Math.round(domBudget);
            const budgetMatch = apiRounded === domRounded;
            this.recordTest('gameState', 'API budget matches DOM display', budgetMatch,
                `API: $${apiRounded}, DOM: $${domRounded}`);
        } else {
            this.recordTest('gameState', 'API budget matches DOM display', false,
                'Could not read budget from DOM');
        }
        
        // Day (API is 0-indexed, UI displays day + 1)
        const apiDay = this.api.gameState.getCurrentDay();
        const domDay = this.getDOMDay();
        
        if (domDay !== null) {
            const dayMatch = apiDay === (domDay - 1);
            this.recordTest('gameState', 'API day matches DOM display', dayMatch,
                `API: Day ${apiDay} (0-indexed), DOM: Day ${domDay} (1-indexed, expected API=${domDay - 1})`);
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
    // MANUAL TESTS
    // ============================================================================
    
    checkFloatingPanelState() {
        const afterCount = this.panelRenderCount;
        const actuallyReset = afterCount > 1;
        
        this.recordTest('actions', 'floatingPanel preserves state on drag/resize', !actuallyReset,
            `Render count: ${afterCount} (should be 1 if state preserved)`);
    },
    
    async testReloadMods() {
        this.log('Testing reloadMods()...');
        
        const lifecycleHooks = window.LifecycleMonitor.getHookCalls();
        const beforeCallbacks = { ...lifecycleHooks };
        
        this.recordTest('actions', 'reloadMods() test started', true,
            `Current hook callbacks: gameInit=${beforeCallbacks.gameInit}, cityLoad=${beforeCallbacks.cityLoad}`);
        
        try {
            await this.api.reloadMods();
            
            setTimeout(() => {
                const afterCallbacks = window.LifecycleMonitor.getHookCalls();
                const hooksReset = Object.values(afterCallbacks).every(count => count === 0);
                
                this.recordTest('actions', 'reloadMods() resets hook callbacks', hooksReset,
                    `Before: gameInit=${beforeCallbacks.gameInit}, After: gameInit=${afterCallbacks.gameInit}`);
            }, 1000);
        } catch (error) {
            this.recordTest('actions', 'reloadMods() execution', false, error.message);
        }
    },
    
    testActions() {
        this.log('Testing game actions...');
        
        // Test: setPause
        try {
            const wasPaused = this.api.gameState.isPaused();
            this.api.actions.setPause(true);
            setTimeout(() => {
                const isNowPaused = this.api.gameState.isPaused();
                this.recordTest('actions', 'setPause(true) works', isNowPaused,
                    `Was paused: ${wasPaused}, now paused: ${isNowPaused}`);
                this.api.actions.setPause(wasPaused);
            }, 500);
        } catch (error) {
            this.recordTest('actions', 'setPause', false, error.message);
        }
        
        // Test: setSpeed
        try {
            const originalSpeed = this.api.gameState.getGameSpeed();
            this.api.actions.setSpeed('fast');
            setTimeout(() => {
                const newSpeed = this.api.gameState.getGameSpeed();
                this.recordTest('actions', 'setSpeed() changes speed', newSpeed === 'fast',
                    `Original: ${originalSpeed}, new: ${newSpeed}`);
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
                this.api.actions.setMoney(originalBudget);
            }, 500);
        } catch (error) {
            this.recordTest('actions', 'setMoney', false, error.message);
        }
    },
    
    async testSpeedMultiplier() {
        this.log('Testing setSpeedMultiplier (complex test)...');
        this.clearSpeedTestProgress();
        
        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const getTime = () => this.getInGameTime();
        
        try {
            this.api.actions.setSpeed('fast');

            // 1. Pause and confirm (2 seconds)
            this.addSpeedTestStep('Setting pause...', null, 'Calling setPause(true)');
            this.api.actions.setPause(true);
            await wait(500);
            
            this.addSpeedTestStep('Verifying pause (2s wait)...', null, 'Checking if time freezes');
            const pauseTime1 = getTime();
            await wait(2000);
            const stillPaused1 = getTime() === pauseTime1;
            
            this.addSpeedTestStep('Pause verification 1', stillPaused1, 
                stillPaused1 ? 'Game paused correctly' : `Time changed: ${pauseTime1} → ${getTime()}`);
            
            if (!stillPaused1) {
                this.recordTest('actions', 'setSpeedMultiplier test', false, 
                    'Failed at pause verification 1');
                return;
            }
            
            // 2. Set to fast, measure baseline (1 second)
            this.addSpeedTestStep('Setting speed to fast...', null, 'Measuring baseline speed');
            this.api.actions.setSpeed('fast');
            await wait(500);
            const fastStart1 = getTime();
            await wait(1000);
            const fastEnd1 = getTime();
            const baseline = fastEnd1 - fastStart1;
            
            this.addSpeedTestStep('Baseline measurement', true, 
                `Fast speed: ${baseline} seconds/real-second`);
            
            // 3. Pause and confirm (2 seconds)
            this.addSpeedTestStep('Setting pause again...', null, 'Second pause verification');
            await wait(200);
            this.api.actions.setPause(true);
            await wait(500);
            const pauseTime2 = getTime();
            await wait(2000);
            const stillPaused2 = getTime() === pauseTime2;

            
            this.addSpeedTestStep('Pause verification 2', stillPaused2,
                stillPaused2 ? 'Game paused correctly' : `Time changed: ${pauseTime2} → ${getTime()}`);
            
            if (!stillPaused2) {
                this.recordTest('actions', 'setSpeedMultiplier test', false,
                    'Failed at pause verification 2');
                this.api.actions.setSpeedMultiplier('fast', 1);
                return;
            }
            
            // 4. Set multiplier to 10
            this.addSpeedTestStep('Setting multiplier to 10x...', null, 'Calling setSpeedMultiplier("fast", 10)');
            this.api.actions.setSpeedMultiplier('fast', 10);
            
            // 5. Set to fast, measure with multiplier (1 second)
            this.addSpeedTestStep('Measuring 10x speed...', null, 'Setting speed to fast');
            this.api.actions.setSpeed('fast');
            await wait(500);
            const fastStart2 = getTime();
            await wait(1000);
            const fastEnd2 = getTime();
            const withMultiplier = fastEnd2 - fastStart2;
            
            this.addSpeedTestStep('10x measurement', true,
                `With 10x: ${withMultiplier} seconds/real-second`);
            
            // 6. Verify
            const expected = baseline * 10;
            const tolerance = baseline * 0.2; // 20% tolerance
            const multiplierWorked = Math.abs(withMultiplier - expected) <= tolerance;
            
            this.addSpeedTestStep('Verifying multiplier effect', multiplierWorked,
                `Expected: ${expected}±${tolerance.toFixed(1)}s, Got: ${withMultiplier}s`);
            
            this.recordTest('actions', 'setSpeedMultiplier changes speed', multiplierWorked,
                `Baseline: ${baseline}s/sec, With 10x: ${withMultiplier}s/sec, Expected: ${expected}s/sec ±${tolerance.toFixed(1)}s`);
            
            // 7. Reset
            this.addSpeedTestStep('Resetting...', null, 'Setting multiplier back to 1 and pausing');
            this.api.actions.setSpeedMultiplier('fast', 1);
            this.api.actions.setPause(true);
            this.addSpeedTestStep('Test complete', true, 'Cleanup done');
            
        } catch (error) {
            this.addSpeedTestStep('Test failed', false, error.message);
            this.recordTest('actions', 'setSpeedMultiplier test execution', false, 
                error.message);
            this.api.actions.setSpeedMultiplier('fast', 1);
            this.api.actions.setPause(true);
        }
    },
    
    testStorage() {
        this.log('Testing storage API...');
        
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
    
    testModifyConstants() {
        this.log('Testing modifyConstants...');
        
        this.recordTest('modifyConstants', 'Test suite ready', true,
            'Call modifyConstants, then start new game to verify. STARTING_MONEY = 10B, DEFAULT_TICKET_COST = 5');

        window.SubwayBuilderAPI.modifyConstants({
            STARTING_MONEY: 10_000_000_000, // 10B instead of 3B
            DEFAULT_TICKET_COST: 5,
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
    },
    
    updateTestUI() {
        if (this._forceUpdate) {
            this._forceUpdate();
        }
    },
    
    renderTestPanel() {
        const h = this.h;
        const self = this;
        
        const TestPanel = () => {
            const [, forceUpdate] = this.React.useReducer(x => x + 1, 0);
            
            this.React.useEffect(() => {
                self._forceUpdate = forceUpdate;
            }, []);
            
            this.React.useEffect(() => {
                self.panelRenderCount++;
            });
            
            const { passed, failed, total, tests } = self.results;
            const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : 0;
            
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
                    ])
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
                        key: 'speed',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testSpeedMultiplier()
                    }, 'Test Speed Multiplier'),
                    h('button', {
                        key: 'storage',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testStorage()
                    }, 'Test Storage'),
                    h('button', {
                        key: 'dom',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testDOMAPIConsistency()
                    }, 'Test DOM/API'),
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
                        key: 'constants',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90',
                        onClick: () => self.testModifyConstants()
                    }, 'Test modifyConstants'),
                    h('button', {
                        key: 'clear',
                        className: 'px-3 py-1.5 text-xs rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80',
                        onClick: () => {
                            self.results = { passed: 0, failed: 0, total: 0, tests: [] };
                            Object.keys(self.categories).forEach(cat => {
                                self.categories[cat].tests = [];
                            });
                            self.clearSpeedTestProgress();
                            forceUpdate();
                        }
                    }, 'Clear Results')
                ]),
                
                // Speed test progress (if running)
                self.speedTestProgress.length > 0 && h('div', {
                    key: 'speed-progress',
                    className: 'px-4 py-3 border-b border-border bg-blue-500/10'
                }, [
                    h('div', {
                        key: 'title',
                        className: 'font-semibold text-sm mb-2'
                    }, 'Speed Multiplier Test Progress:'),
                    h('div', {
                        key: 'steps',
                        className: 'space-y-1 text-xs'
                    }, self.speedTestProgress.map((step, idx) => 
                        h('div', {
                            key: idx,
                            className: `flex items-start gap-2 ${
                                step.passed === true ? 'text-green-600 dark:text-green-400' :
                                step.passed === false ? 'text-red-600 dark:text-red-400' :
                                'text-muted-foreground'
                            }`
                        }, [
                            h('span', { key: 'icon' }, 
                                step.passed === true ? '✓' :
                                step.passed === false ? '✗' :
                                '⏳'
                            ),
                            h('div', { key: 'content', className: 'flex-1' }, [
                                h('div', { key: 'step', className: 'font-medium' }, step.step),
                                step.details && h('div', {
                                    key: 'details',
                                    className: 'text-[10px] text-muted-foreground mt-0.5'
                                }, step.details)
                            ])
                        ])
                    ))
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
                                            h('span', { key: 'text' }, test.name)
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
                    h('div', { key: 'render' }, `Panel renders: ${self.panelRenderCount}`)
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