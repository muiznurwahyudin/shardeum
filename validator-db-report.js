const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Constants
const INSTANCES_DIR = 'instances';
const VALIDATOR_DB_PATH = path.join('db', 'shardeum.sqlite');
const ARCHIVER_DB_PATH = path.join('instances', 'archiver-db-4000', 'accounts.sqlite3');

// Store account type counts and data
const validatorStats = new Map();
const totalStats = new Map();
const archiverAccounts = new Map();
let totalAccounts = 0;

// Add this after the existing Maps
const uniqueAccounts = new Map(); // Track unique accounts by accountId -> { accountType, data, validators: Map<port, data> }

async function getDB(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve(db);
      }
    });
  });
}

async function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function loadArchiverAccounts() {
  if (!fs.existsSync(ARCHIVER_DB_PATH)) {
    throw new Error(`Archiver database not found at path: ${ARCHIVER_DB_PATH}`);
  }

  const db = await getDB(ARCHIVER_DB_PATH);
  try {
    const accounts = await runQuery(db, 'SELECT accountId, data FROM accounts');
    
    if (!accounts || accounts.length === 0) {
      throw new Error('Archiver database contains no accounts!');
    }

    for (const account of accounts) {
      archiverAccounts.set(account.accountId, JSON.parse(account.data));
    }
    console.log(`Loaded ${archiverAccounts.size} accounts from archiver`);
  } catch (error) {
    console.error('Error loading archiver accounts:', error);
    throw error; // Re-throw to stop execution
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

async function compareValidatorAccount(validatorPort, accountId, accountData) {
  const archiverAccount = archiverAccounts.get(accountId);
  if (!archiverAccount) {
    console.log(`Account ${accountId} from validator ${validatorPort} not found in archiver`);
    return false;
  }

  // Deep comparison of account data
  const validatorStr = JSON.stringify(accountData, Object.keys(accountData).sort());
  const archiverStr = JSON.stringify(archiverAccount, Object.keys(archiverAccount).sort());
  
  if (validatorStr !== archiverStr) {
    console.log(`Account ${accountId} data mismatch between validator ${validatorPort} and archiver`);
    console.log('Validator data:', accountData);
    console.log('Archiver data:', archiverAccount);
    return false;
  }
  return true;
}

async function analyzeValidatorDB(validatorPort) {
  const dbPath = path.join(INSTANCES_DIR, `shardus-instance-${validatorPort}`, VALIDATOR_DB_PATH);
  
  if (!fs.existsSync(dbPath)) {
    console.log(`Database not found for validator ${validatorPort}`);
    return;
  }

  try {
    const db = await getDB(dbPath);
    const accounts = await runQuery(db, 'SELECT accountId, data FROM accountsEntry');
    
    const accountTypeCounts = new Map();
    let validatorAccountCount = 0;
    let mismatchCount = 0;
    
    for (const row of accounts) {
      const accountData = JSON.parse(row.data);
      const accountType = accountData.accountType;

      // Compare with archiver data
      const isMatch = await compareValidatorAccount(validatorPort, row.accountId, accountData);
      if (!isMatch) {
        mismatchCount++;
      }

      // Track and compare unique accounts
      if (!uniqueAccounts.has(row.accountId)) {
        uniqueAccounts.set(row.accountId, {
          accountType,
          data: accountData,
          validators: new Map([[validatorPort, accountData]])
        });
        totalStats.set(
          accountType,
          (totalStats.get(accountType) || 0) + 1
        );
        totalAccounts++;
      } else {
        // Compare with existing account data
        const existingAccount = uniqueAccounts.get(row.accountId);
        existingAccount.validators.set(validatorPort, accountData);
        
        // Deep comparison of account data
        const existingStr = JSON.stringify(existingAccount.data, Object.keys(existingAccount.data).sort());
        const newStr = JSON.stringify(accountData, Object.keys(accountData).sort());
        
        if (existingStr !== newStr) {
          console.log(`\nAccount data mismatch for ${row.accountId}:`);
          console.log(`Validator ${validatorPort} data:`, accountData);
          console.log('Previously recorded data:', existingAccount.data);
          console.log('Found in validators:', Array.from(existingAccount.validators.keys()).join(', '));
        }
      }

      accountTypeCounts.set(
        accountType, 
        (accountTypeCounts.get(accountType) || 0) + 1
      );
      validatorAccountCount++;
    }

    validatorStats.set(validatorPort, {
      counts: accountTypeCounts,
      total: validatorAccountCount,
      mismatches: mismatchCount
    });

    await new Promise((resolve) => db.close(resolve));
    console.log(`\nAnalyzed validator ${validatorPort} (${validatorAccountCount} accounts, ${mismatchCount} mismatches)`);
  } catch (error) {
    console.error(`Error analyzing validator ${validatorPort}:`, error);
  }
}

async function findValidatorPorts() {
  const ports = [];
  const instancePattern = /shardus-instance-(\d+)/;

  if (fs.existsSync(INSTANCES_DIR)) {
    fs.readdirSync(INSTANCES_DIR).forEach(dir => {
      const match = dir.match(instancePattern);
      if (match) {
        ports.push(match[1]);
      }
    });
  }
  return ports;
}

async function generateReport() {
  console.log('Loading archiver accounts...');
  await loadArchiverAccounts();
  
  console.log('\nStarting validator database analysis...');
  const ports = await findValidatorPorts();
  
  if (ports.length === 0) {
    console.log('No validator instances found');
    return;
  }

  await Promise.all(ports.map(port => analyzeValidatorDB(port)));

  // Add mismatch statistics to the report
  console.log('\n=== Account Mismatch Report ===');
  let totalMismatches = 0;
  for (const [port, stats] of validatorStats) {
    totalMismatches += stats.mismatches;
    console.log(`Validator ${port}: ${stats.mismatches} mismatches out of ${stats.total} accounts`);
  }
  console.log(`\nTotal mismatches across all validators: ${totalMismatches}`);

  // Add account type breakdown for each validator
  console.log('\n=== Account Type Breakdown by Validator ===');
  for (const [port, stats] of validatorStats) {
    console.log(`\nValidator ${port} (Total: ${stats.total}):`);
    for (const [accountType, count] of stats.counts) {
      const percentage = ((count / stats.total) * 100).toFixed(2);
      console.log(`  ${accountType}: ${count} (${percentage}%)`);
    }
  }

  // Add overall account type breakdown
  console.log('\n=== Overall Account Type Breakdown ===');
  for (const [accountType, count] of totalStats) {
    const percentage = ((count / totalAccounts) * 100).toFixed(2);
    console.log(`${accountType}: ${count} (${percentage}%)`);
  }
}

// Run the report
generateReport().catch(error => {
  console.error('Error generating report:', error);
  process.exit(1);
});
