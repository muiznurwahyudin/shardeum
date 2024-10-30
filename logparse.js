const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Tracking variables
let scaleStats = {
    cyclesBelow: 0,
    cyclesAbove: 0,
    lastDesired: null,
    maxActive: 0,
    minActive: Infinity,
    modeChanges: [],
    joinAttempts: 0,
    joinSuccesses: 0,
    syncingNodes: new Set(),
    activeNodes: new Set(),
    formingModeCycles: 0,
    lastCycleStats: null,
    totalSyncingNodes: new Set(),
    joiningNodes: new Map(),
    stuckJoiningNodes: new Map()
};

// Track both cycle and validator stats
let stats = {
    validatorStats: {
        joiningFailures: [],
        networkInitFailures: 0,
        versionMismatches: 0,
        certIssues: 0,
        networkAccountIssues: 0,
        archiverFetchFailures: 0
    },
    archiverStats: {
        totalReceipts: 0,
        receiptsByType: new Map(),
        failedReceipts: 0,
        successfulReceipts: 0
    }
};

// Function to process validator log file
async function processValidatorLog(port) {
    const logPath = `./instances/shardus-instance-${port}/logs/out.log`;
    if (!fs.existsSync(logPath)) {
        console.log(`No validator log found for port ${port}`);
        return;
    }

    const rl = readline.createInterface({
        input: fs.createReadStream(logPath),
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        try {
            // Try to parse the line as JSON first
            let logData;
            try {
                logData = JSON.parse(line);
            } catch {
                // Not JSON, use the raw line
                logData = { msg: line };
            }

            const timestamp = logData.timestamp || line.split(' ')[0];
            const message = logData.msg || line;

            // Track network account issues
            if (message.includes('network account not available yet')) {
                stats.validatorStats.networkAccountIssues++;
            }

            // Track joining failures with more detail
            if (message.includes('error in startupV2 > attemptJoining')) {
                let errorDetail = 'Unknown error';
                
                if (message.includes('no newestCycle yet')) {
                    errorDetail = 'No newest cycle available';
                    stats.validatorStats.networkInitFailures++;
                } else if (message.includes('timeout')) {
                    errorDetail = 'Join request timed out';
                } else if (message.includes('rejected')) {
                    errorDetail = 'Join request rejected';
                }

                stats.validatorStats.joiningFailures.push({
                    port,
                    timestamp,
                    errorDetail,
                    fullMessage: message
                });
            }

            // Track archiver issues with more context
            if (message.includes('fetchNetworkAccountFromArchiver')) {
                if (message.includes('error') || message.includes('failed')) {
                    let errorDetail = message.includes('timeout') ? 'Timeout' : 
                                    message.includes('connection') ? 'Connection failed' : 
                                    'Unknown error';
                    stats.validatorStats.archiverFetchFailures++;
                }
            }

            // Track version issues
            if (message.includes('version out-of-date')) {
                stats.validatorStats.versionMismatches++;
            }

            // Track certificate issues with more detail
            if (message.includes('stakeCert is expired') || message.includes('invalid cert')) {
                stats.validatorStats.certIssues++;
            }

        } catch (err) {
            console.error(`Error processing log line for port ${port}:`, err);
        }
    }
}

// Function to find all validator ports
function findValidatorPorts() {
    const instancesDir = './instances';
    const portPattern = /shardus-instance-(\d+)/;
    const ports = [];

    if (fs.existsSync(instancesDir)) {
        fs.readdirSync(instancesDir).forEach(dir => {
            const match = dir.match(portPattern);
            if (match) {
                ports.push(match[1]);
            }
        });
    }

    return ports;
}

// Function to process receipt logs
async function processReceiptLogs() {
    const logsDir = './instances/data-logs/127.0.0.1_4000';
    const receiptPattern = /receipt-log(\d+)\.txt$/;
    
    if (!fs.existsSync(logsDir)) {
        console.log('No receipt logs directory found');
        return;
    }

    const files = fs.readdirSync(logsDir)
        .filter(file => receiptPattern.test(file))
        .map(file => path.join(logsDir, file));

    for (const file of files) {
        const rl = readline.createInterface({
            input: fs.createReadStream(file),
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            // Skip empty lines or non-receipt lines
            if (!line.trim() || line.startsWith('Error')) continue;

            try {
                const receipt = JSON.parse(line);
                stats.archiverStats.totalReceipts++;

                // Track receipt types
                const type = receipt.type || 'unknown';
                stats.archiverStats.receiptsByType.set(
                    type, 
                    (stats.archiverStats.receiptsByType.get(type) || 0) + 1
                );

                // Track success/failure
                if (receipt.success === true) {
                    stats.archiverStats.successfulReceipts++;
                } else if (receipt.success === false) {
                    stats.archiverStats.failedReceipts++;
                    console.log(`Failed receipt: ${JSON.stringify(receipt, null, 2)}`);
                }

            } catch (err) {
                // Only log parsing errors for lines that look like they should be JSON
                if (line.trim().startsWith('{')) {
                    console.error(`Error parsing receipt: ${err.message}`);
                    console.error(`Problematic line: ${line}`);
                }
            }
        }
    }
}

// Replace the single log file path with a function to find all cycle logs
function findCycleLogs() {
    const logsDir = './instances/data-logs/127.0.0.1_4000';
    const cyclePattern = /^cycle-log(\d+)\.txt$/;
    const files = [];

    if (fs.existsSync(logsDir)) {
        fs.readdirSync(logsDir)
            .filter(file => {
                return cyclePattern.test(file);
            })
            .forEach(file => files.push(path.join(logsDir, file)));
    }

    return files;
}

// Modify the main cycle log processing
async function processCycleLogs() {
    const cycleLogFiles = findCycleLogs();
    console.log(`Found ${cycleLogFiles.length} cycle log files`);

    for (const logFile of cycleLogFiles) {
        const rl = readline.createInterface({
            input: fs.createReadStream(logFile),
            crlfDelay: Infinity
        });

        for await (const line of rl) {
            // Skip empty lines or non-JSON lines
            if (!line.trim() || 
                line.startsWith('End:') || 
                !line.trim().startsWith('{')) {
                continue;
            }

            try {
                // Remove the line number prefix (e.g., "1|", "2|", etc.)
                const jsonContent = line.replace(/^\d+\|/, '');
                const logEntry = JSON.parse(jsonContent);
                const cycleRecord = logEntry.cycleRecord;
                
                // Extract key metrics
                const counter = logEntry.counter;
                const active = Array.isArray(cycleRecord.active) ? cycleRecord.active.length : 
                              (typeof cycleRecord.active === 'number' ? cycleRecord.active : 0);
                const desired = cycleRecord.desired;
                const mode = cycleRecord.mode;
                
                // Store last cycle stats for debugging
                scaleStats.lastCycleStats = {
                    counter,
                    active,
                    desired,
                    mode,
                    activeType: typeof cycleRecord.active,
                    activeValue: cycleRecord.active,
                    joined: cycleRecord.joined || [],
                    syncing: cycleRecord.syncing || []
                };

                // Track forming mode
                if (mode === 'forming') {
                    scaleStats.formingModeCycles++;
                    console.log(`Cycle ${counter}: Network in forming mode. Active: ${active}, Desired: ${desired}`);
                    console.log(`Joined nodes: ${cycleRecord.joined?.length || 0}, Syncing nodes: ${cycleRecord.syncing?.length || 0}`);
                }

                // Track min/max active nodes
                scaleStats.maxActive = Math.max(scaleStats.maxActive, active);
                scaleStats.minActive = Math.min(scaleStats.minActive, active);
                
                // Track desired vs actual
                if (active < desired) {
                    scaleStats.cyclesBelow++;
                    console.log(`Cycle ${counter}: Active nodes (${active}) below desired (${desired})`);
                    
                    if (cycleRecord.joined?.length > 0) {
                        console.log(`Cycle ${counter}: Nodes joining: ${cycleRecord.joined.length}`);
                    }
                    if (cycleRecord.syncing?.length > 0) {
                        console.log(`Cycle ${counter}: Nodes syncing: ${cycleRecord.syncing.length}`);
                    }
                }

                // Track node state changes safely
                if (Array.isArray(cycleRecord.joined)) {
                    cycleRecord.joined.forEach(node => {
                        scaleStats.joinAttempts++;
                        scaleStats.syncingNodes.add(node);
                        if (!scaleStats.joiningNodes.has(node)) {
                            scaleStats.joiningNodes.set(node, counter);
                        }
                    });
                }

                if (Array.isArray(cycleRecord.active)) {
                    cycleRecord.active.forEach(node => {
                        if (scaleStats.syncingNodes.has(node)) {
                            scaleStats.joinSuccesses++;
                            scaleStats.syncingNodes.delete(node);
                        }
                        scaleStats.activeNodes.add(node);
                    });
                }

                if (Array.isArray(cycleRecord.syncing)) {
                    cycleRecord.syncing.forEach(node => {
                        scaleStats.totalSyncingNodes.add(node);
                    });
                }

                // Check if nodes have been stuck in joining state
                const stuckThreshold = 5; // Number of cycles to consider a node "stuck"
                scaleStats.joiningNodes.forEach((startCycle, node) => {
                    if (counter - startCycle > stuckThreshold && 
                        !scaleStats.activeNodes.has(node) && 
                        !scaleStats.syncingNodes.has(node)) {
                        scaleStats.stuckJoiningNodes.set(node, startCycle);
                    }
                });

            } catch (err) {
                console.error(`Error parsing line in ${logFile}: ${err.message}`);
                console.error(`Problematic line content: "${line}"`);
                if (scaleStats.lastCycleStats) {
                    console.error('Last cycle stats:', JSON.stringify(scaleStats.lastCycleStats, null, 2));
                }
            }
        }
    }
}

// Add this new function near the top of the file, after the stats declarations
function countAllLogFiles() {
    const results = {
        cycleLogs: 0,
        receiptLogs: 0,
        validatorLogs: 0,
        logDirectories: new Set()
    };

    // Check cycle and receipt logs
    const dataLogsDir = './instances/data-logs/127.0.0.1_4000';
    if (fs.existsSync(dataLogsDir)) {
        results.logDirectories.add(dataLogsDir);
        const files = fs.readdirSync(dataLogsDir);
        results.cycleLogs = files.filter(f => f.startsWith('cycle-log')).length;
        results.receiptLogs = files.filter(f => f.startsWith('receipt-log')).length;
    }

    // Check validator logs
    const instancesDir = './instances';
    if (fs.existsSync(instancesDir)) {
        const validatorDirs = fs.readdirSync(instancesDir)
            .filter(dir => dir.startsWith('shardus-instance-'));
        
        validatorDirs.forEach(dir => {
            const logPath = path.join(instancesDir, dir, 'logs');
            if (fs.existsSync(logPath)) {
                results.logDirectories.add(logPath);
                if (fs.existsSync(path.join(logPath, 'out.log'))) {
                    results.validatorLogs++;
                }
            }
        });
    }

    return results;
}

// Update the main function
async function main() {
    // Add this at the start of main
    const logCounts = countAllLogFiles();
    console.log('\nLog Files Found:');
    console.log('---------------');
    console.log(`Cycle Logs: ${logCounts.cycleLogs}`);
    console.log(`Receipt Logs: ${logCounts.receiptLogs}`);
    console.log(`Validator Logs: ${logCounts.validatorLogs}`);
    console.log('\nLog Directories:');
    logCounts.logDirectories.forEach(dir => console.log(`- ${dir}`));
    console.log(''); // Empty line for spacing

    await processCycleLogs();
    
    const ports = findValidatorPorts();
    console.log(`Found ${ports.length} validator instances`);
    
    for (const port of ports) {
        await processValidatorLog(port);
    }

    await processReceiptLogs();

    // Output statistics
    console.log('\n=== Network Scaling Analysis ===');
    console.log('Network Size:');
    console.log(`  • Maximum active nodes: ${scaleStats.maxActive}`);
    console.log(`  • Minimum active nodes: ${scaleStats.minActive}`);
    console.log(`  • Current active nodes: ${scaleStats.activeNodes.size}`);
    
    console.log('\nNetwork Formation:');
    console.log(`  • Cycles below desired count: ${scaleStats.cyclesBelow}`);
    console.log(`  • Cycles spent in forming mode: ${scaleStats.formingModeCycles}`);
    
    console.log('\nNode Join Statistics:');
    const joinRate = scaleStats.joinAttempts === 0 ? 
        'No join attempts recorded' : 
        `${((scaleStats.joinSuccesses / scaleStats.joinAttempts) * 100).toFixed(2)}%`;
    console.log(`  • Join success rate: ${joinRate}`);
    console.log(`  • Total join attempts: ${scaleStats.joinAttempts}`);
    console.log(`  • Successful joins: ${scaleStats.joinSuccesses}`);
    
    console.log('\nNode States:');
    console.log(`  • Total nodes that entered syncing state: ${scaleStats.totalSyncingNodes.size}`);
    console.log(`  • Currently syncing nodes: ${scaleStats.syncingNodes.size}`);
    console.log(`  • Total nodes that were active: ${scaleStats.activeNodes.size}`);
    
    if (scaleStats.lastCycleStats) {
        console.log('\n=== Last Cycle Details ===');
        const stats = scaleStats.lastCycleStats;
        console.log(`Cycle Counter: ${stats.counter}`);
        console.log(`Network Mode: ${stats.mode}`);
        console.log(`Active Nodes: ${stats.active} (desired: ${stats.desired})`);
        console.log(`Joining Nodes: ${stats.joined.length}`);
        console.log(`Syncing Nodes: ${stats.syncing.length}`);
    }

    console.log('\n=== Stuck Nodes Analysis ===');
    if (scaleStats.stuckJoiningNodes.size > 0) {
        console.log(`Found ${scaleStats.stuckJoiningNodes.size} nodes stuck in joining state:`);
        scaleStats.stuckJoiningNodes.forEach((startCycle, node) => {
            console.log(`  • Node ${node} - Stuck since cycle ${startCycle}`);
        });
    } else {
        console.log('No nodes detected as stuck in joining state');
    }

    console.log('\n=== Validator Issues ===');
    const vStats = stats.validatorStats;
    if (Object.values(vStats).some(v => Array.isArray(v) ? v.length > 0 : v > 0)) {
        console.log('Found the following issues:');
        if (vStats.joiningFailures.length > 0) {
            console.log(`  • Join Failures: ${vStats.joiningFailures.length}`);
            const groupedFailures = new Map();
            vStats.joiningFailures.forEach(failure => {
                const key = failure.errorDetail;
                if (!groupedFailures.has(key)) {
                    groupedFailures.set(key, []);
                }
                groupedFailures.get(key).push(failure);
            });
            
            groupedFailures.forEach((failures, errorType) => {
                console.log(`    - ${errorType} (${failures.length} occurrences):`);
                failures.forEach(f => {
                    console.log(`      Port ${f.port} at ${f.timestamp}`);
                });
            });
        }
        if (vStats.networkInitFailures > 0) {
            console.log(`  • Network Initialization Failures: ${vStats.networkInitFailures}`);
        }
        if (vStats.versionMismatches > 0) {
            console.log(`  • Version Mismatches: ${vStats.versionMismatches}`);
        }
        if (vStats.certIssues > 0) {
            console.log(`  • Certificate Issues: ${vStats.certIssues}`);
        }
        if (vStats.networkAccountIssues > 0) {
            console.log(`  • Network Account Issues: ${vStats.networkAccountIssues}`);
        }
        if (vStats.archiverFetchFailures > 0) {
            console.log(`  • Archiver Fetch Failures: ${vStats.archiverFetchFailures}`);
        }
    } else {
        console.log('No validator issues detected');
    }

    console.log('\n=== Receipt Analysis ===');
    const rStats = stats.archiverStats;
    if (rStats.totalReceipts > 0) {
        console.log(`Total Receipts Processed: ${rStats.totalReceipts}`);
        console.log(`Success Rate: ${((rStats.successfulReceipts / rStats.totalReceipts) * 100).toFixed(2)}%`);
        console.log('\nReceipt Types:');
        rStats.receiptsByType.forEach((count, type) => {
            console.log(`  • ${type}: ${count} (${((count / rStats.totalReceipts) * 100).toFixed(2)}%)`);
        });
        if (rStats.failedReceipts > 0) {
            console.log(`\nFailed Receipts: ${rStats.failedReceipts}`);
        }
    } else {
        console.log('No receipts found in logs');
    }

    // Add receipt warnings to Summary if needed
    console.log('\n=== Summary ===');
    if (scaleStats.maxActive === 0) {
        console.log('⚠️  Warning: No active nodes detected during the analysis period');
    }
    if (scaleStats.joinAttempts === 0) {
        console.log('⚠️  Warning: No join attempts recorded');
    }
    if (scaleStats.formingModeCycles > 0) {
        console.log(`ℹ️  Network spent ${scaleStats.formingModeCycles} cycles in forming mode`);
    }
    if (vStats.joiningFailures.length > 0) {
        console.log(`⚠️  Warning: ${vStats.joiningFailures.length} validator join failures detected`);
    }
    if (vStats.networkInitFailures > 0) {
        console.log(`⚠️  Warning: ${vStats.networkInitFailures} network initialization failures detected`);
    }
    if (rStats.failedReceipts > 0) {
        console.log(`⚠️  Warning: ${rStats.failedReceipts} failed receipts detected`);
    }
    if (rStats.totalReceipts === 0) {
        console.log('ℹ️  No receipts were processed during this period');
    }

    console.log('\nAnalysis complete!');
}

// Call main function
main().catch(console.error);
