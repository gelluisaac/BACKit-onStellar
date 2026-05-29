#![no_std]

use soroban_sdk::{contract, contractimpl, token, Address, Bytes, Env, Vec};

mod admin;
mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

use backit_shared::{is_valid_outcome, OUTCOME_DOWN, OUTCOME_UP};
use errors::CallRegistryError;
use events::*;
use storage::*;
use types::*;

const MAX_CALL_PAGE_SIZE: u32 = 20;

/// CallRegistry contract implementation.
/// Manages prediction calls and staking on market outcomes.
#[contract]
pub struct CallRegistry;

fn evaluate_condition_impl(condition: &ConditionType, start_price: i128, end_price: i128) -> bool {
    match condition {
        ConditionType::TargetAbove(target) => end_price > *target,
        ConditionType::TargetBelow(target) => end_price < *target,
        ConditionType::PercentUp(percent) => {
            if start_price <= 0 {
                return false;
            }
            end_price * 100 >= start_price * (100 + *percent as i128)
        }
        ConditionType::PercentDown(percent) => {
            if start_price <= 0 {
                return false;
            }
            end_price * 100 <= start_price * (100 - *percent as i128)
        }
        ConditionType::Range(min, max) => {
            if min > max {
                return false;
            }
            end_price >= *min && end_price <= *max
        }
    }
}

#[contractimpl]
impl CallRegistry {
    /// Initialise the contract with an admin and an outcome manager.
    /// # Errors
    /// * [`CallRegistryError::AlreadyInitialized`] – called more than once.
    pub fn initialize(
        env: Env,
        admin: Address,
        outcome_manager: Address,
    ) -> Result<(), CallRegistryError> {
        if get_config(&env).is_some() {
            return Err(CallRegistryError::AlreadyInitialized);
        }

        admin.require_auth();

        let config = ContractConfig {
            admin: admin.clone(),
            outcome_manager: outcome_manager.clone(),
            fee_bps: 0,
            max_stake_per_user: 0,
        };

        set_config(&env, &config);
        extend_storage_ttl(&env);

        env.events()
            .publish(("call_registry", "initialized"), (admin, outcome_manager));

        Ok(())
    }

    /// Create a new prediction call.
    /// # Errors
    /// * [`CallRegistryError::InvalidStakeAmount`] – `stake_amount` ≤ 0.
    /// * [`CallRegistryError::InvalidEndTime`] – `end_ts` is not in the future.
    /// * [`CallRegistryError::InvalidOutcomeCount`] – `outcome_count` < 2.
    pub fn create_call(
        env: Env,
        creator: Address,
        stake_token: Address,
        stake_amount: i128,
        end_ts: u64,
        token_address: Address,
        pair_id: Bytes,
        ipfs_cid: Bytes,
        condition: ConditionType,
        outcome_count: u32,
    ) -> Result<Call, CallRegistryError> {
        creator.require_auth();

        if stake_amount <= 0 {
            return Err(CallRegistryError::InvalidStakeAmount);
        }

        if outcome_count < 2 {
            return Err(CallRegistryError::InvalidOutcomeCount);
        }

        let current_timestamp = env.ledger().timestamp();
        if end_ts <= current_timestamp {
            return Err(CallRegistryError::InvalidEndTime);
        }

        let call_id = next_call_id(&env);

        let mut outcome_stakes = soroban_sdk::Map::new(&env);
        let mut stakes = soroban_sdk::Map::new(&env);
        
        // Initialize maps for each outcome
        for i in 1..=outcome_count {
            outcome_stakes.set(i, 0);
            stakes.set(i, soroban_sdk::Map::new(&env));
        }

        let call = Call {
            id: call_id,
            creator: creator.clone(),
            stake_token: stake_token.clone(),
            stake_amount,
            end_ts,
            token_address: token_address.clone(),
            pair_id: pair_id.clone(),
            ipfs_cid: ipfs_cid.clone(),
            outcome_count,
            outcome_stakes,
            stakes,
            outcome: 0,
            start_price: 0,
            end_price: 0,
            condition,
            settled: false,
            created_at: current_timestamp,
            cancelled: false,
        };

        set_call(&env, &call);
        record_call_created(&env);
        extend_storage_ttl(&env);

        emit_call_created(
            &env,
            call_id,
            &creator,
            &stake_token,
            stake_amount,
            end_ts,
            &token_address,
            &pair_id,
            &ipfs_cid,
            outcome_count,
        );

        Ok(call)
    }

    /// Extend the TTL of a specific call's persistent storage entry.
    /// Anyone may call this to prevent an active call from being archived.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`] – `call_id` does not exist.
    pub fn extend_call_ttl(env: Env, call_id: u64) -> Result<(), CallRegistryError> {
        let key = storage::DataKey::Call(call_id);
        if !env.storage().persistent().has(&key) {
            return Err(CallRegistryError::CallNotFound);
        }
        env.storage().persistent().extend_ttl(
            &key,
            storage::PERSISTENT_LIFETIME_THRESHOLD,
            storage::PERSISTENT_BUMP_AMOUNT,
        );
        Ok(())
    }

    /// Add stake to an existing call.
    /// # Errors
    /// * [`CallRegistryError::InvalidStakeAmount`] – `amount` ≤ 0.
    /// * [`CallRegistryError::CallNotFound`]        – `call_id` does not exist.
    /// * [`CallRegistryError::CallEnded`]           – call's `end_ts` has passed.
    /// * [`CallRegistryError::CallSettled`]         – call is already settled.
    /// * [`CallRegistryError::InvalidPosition`]     – `position` ∉ [1, outcome_count].
    pub fn stake_on_call(
        env: Env,
        staker: Address,
        call_id: u64,
        amount: i128,
        position: u32,
    ) -> Result<Call, CallRegistryError> {
        staker.require_auth();

        if amount <= 0 {
            return Err(CallRegistryError::InvalidStakeAmount);
        }

        let mut call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        let current_timestamp = env.ledger().timestamp();
        if current_timestamp >= call.end_ts {
            return Err(CallRegistryError::CallEnded);
        }

        if call.settled {
            return Err(CallRegistryError::CallSettled);
        }

        if call.cancelled {
            panic!("Call has been cancelled");
        }

        // Validate position is within valid range
        if position < 1 || position > call.outcome_count {
            return Err(CallRegistryError::InvalidPosition);
        }

        // Per-user stake cap
        let config = get_config(&env).expect("Contract not initialized");
        if config.max_stake_per_user > 0 {
            let outcome_stakes = call.stakes.get(position).unwrap_or_else(|| soroban_sdk::Map::new(&env));
            let existing = outcome_stakes.get(staker.clone()).unwrap_or(0);
            if existing + amount > config.max_stake_per_user {
                panic!("Stake exceeds max_stake_per_user cap");
            }
        }

        let token_client = token::Client::new(&env, &call.stake_token);
        token_client.transfer(&staker, &env.current_contract_address(), &amount);

        // Update stake maps
        let current_total = call.outcome_stakes.get(position).unwrap_or(0);
        call.outcome_stakes.set(position, current_total + amount);

        let mut outcome_stakers = call.stakes.get(position).unwrap_or_else(|| soroban_sdk::Map::new(&env));
        let current_staker_stake = outcome_stakers.get(staker.clone()).unwrap_or(0);
        outcome_stakers.set(staker.clone(), current_staker_stake + amount);
        call.stakes.set(position, outcome_stakers);

        set_call(&env, &call);
        add_staker_call(&env, &staker, call_id);
        record_stake(&env, &staker, amount);
        extend_storage_ttl(&env);

        emit_stake_added(&env, call_id, &staker, amount, position);

        Ok(call)
    }

    /// Set the maximum individual stake per user per position per call (admin only).
    /// Pass `0` to remove the cap.
    pub fn set_max_stake_per_user(env: Env, new_max: i128) {
        admin::set_max_stake_per_user(env, new_max);
    }

    /// Resolve a call with an outcome (outcome_manager only).
    /// # Errors
    /// * [`CallRegistryError::NotInitialized`] – contract not initialised.
    /// * [`CallRegistryError::CallNotFound`]   – `call_id` does not exist.
    /// * [`CallRegistryError::InvalidOutcome`] – `outcome` ∉ [1, outcome_count].
    /// * [`CallRegistryError::CallNotEnded`]   – `end_ts` has not yet passed.
    pub fn resolve_call(
        env: Env,
        call_id: u64,
        outcome: u32,
        end_price: i128,
    ) -> Result<Call, CallRegistryError> {
        let config = get_config(&env).ok_or(CallRegistryError::NotInitialized)?;
        config.outcome_manager.require_auth();

        let mut call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        // Validate outcome is within valid range
        if outcome < 1 || outcome > call.outcome_count {
            return Err(CallRegistryError::InvalidOutcome);
        }

        let current_timestamp = env.ledger().timestamp();
        if current_timestamp < call.end_ts {
            return Err(CallRegistryError::CallNotEnded);
        }

        call.outcome = outcome;
        call.end_price = end_price;

        set_call(&env, &call);
        extend_storage_ttl(&env);

        emit_call_resolved(&env, call_id, outcome, end_price);

        Ok(call)
    }

    /// Mark a call as settled (outcome_manager only).
    /// # Errors
    /// * [`CallRegistryError::NotInitialized`] – contract not initialised.
    /// * [`CallRegistryError::CallNotFound`]   – `call_id` does not exist.
    /// * [`CallRegistryError::CallSettled`]     – call is already settled.
    pub fn mark_settled(env: Env, call_id: u64) -> Result<(), CallRegistryError> {
        let config = get_config(&env).ok_or(CallRegistryError::NotInitialized)?;
        config.outcome_manager.require_auth();

        let mut call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        if call.settled {
            return Err(CallRegistryError::CallSettled);
        }

        call.settled = true;
        set_call(&env, &call);

        Ok(())
    }

    /// Release escrowed tokens to a recipient (outcome_manager only).
    /// # Errors
    /// * [`CallRegistryError::NotInitialized`] – contract not initialised.
    /// * [`CallRegistryError::CallNotFound`]   – `call_id` does not exist.
    pub fn release_escrow(
        env: Env,
        call_id: u64,
        to: Address,
        amount: i128,
    ) -> Result<(), CallRegistryError> {
        let config = get_config(&env).ok_or(CallRegistryError::NotInitialized)?;
        config.outcome_manager.require_auth();

        let call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        let token_client = token::Client::new(&env, &call.stake_token);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        Ok(())
    }

    /// Transfer admin privileges to a new address (admin only).
    /// # Errors
    /// Propagates errors from [`admin::set_admin`].
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), CallRegistryError> {
        admin::set_admin(env, new_admin)
    }

    /// Replace the outcome manager (admin only).
    /// # Errors
    /// Propagates errors from [`admin::set_outcome_manager`].
    pub fn set_outcome_manager(env: Env, new_manager: Address) -> Result<(), CallRegistryError> {
        admin::set_outcome_manager(env, new_manager)
    }

    /// Set the protocol fee in basis points, e.g. 100 = 1 % (admin only).
    /// # Errors
    /// Propagates errors from [`admin::set_fee`].
    pub fn set_fee(env: Env, new_fee_bps: u32) -> Result<(), CallRegistryError> {
        admin::set_fee(env, new_fee_bps)
    }

    /// Get current contract configuration.
    /// # Errors
    /// * [`CallRegistryError::NotInitialized`] – contract not initialised.
    pub fn get_config(env: Env) -> Result<ContractConfig, CallRegistryError> {
        get_config(&env).ok_or(CallRegistryError::NotInitialized)
    }

    /// Get call data by ID.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`] – `call_id` does not exist.
    pub fn get_call(env: Env, call_id: u64) -> Result<Call, CallRegistryError> {
        get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)
    }

    /// Get the condition type for a specific call.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`] – `call_id` does not exist.
    pub fn get_condition(env: Env, call_id: u64) -> Result<ConditionType, CallRegistryError> {
        let call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;
        Ok(call.condition)
    }

    /// Evaluate whether price movement satisfies the supplied condition.
    pub fn evaluate_condition(
        _env: Env,
        condition: ConditionType,
        start_price: i128,
        end_price: i128,
    ) -> bool {
        evaluate_condition_impl(&condition, start_price, end_price)
    }

    /// Get all calls created by a specific address (unbounded scan — prefer paginated variant).
    pub fn get_calls_by_creator(env: Env, creator: Address) -> Vec<Call> {
        let mut calls = Vec::new(&env);
        let total_calls = get_call_counter(&env);

        for i in 1..=total_calls {
            if let Some(call) = get_call(&env, i) {
                if call.creator == creator {
                    calls.push_back(call);
                }
            }
        }

        calls
    }

    /// Get a paginated slice of calls starting at `start_id`.
    /// Returns at most [`MAX_CALL_PAGE_SIZE`] calls.
    pub fn get_calls_paginated(env: Env, start_id: u64, limit: u32) -> Vec<Call> {
        let mut calls = Vec::new(&env);
        let total_calls = get_call_counter(&env);
        let page_size = limit.min(MAX_CALL_PAGE_SIZE);

        if page_size == 0 {
            return calls;
        }

        let mut count = 0;
        let mut current = if start_id < 1 { 1 } else { start_id };

        while count < page_size && current <= total_calls {
            if let Some(call) = get_call(&env, current) {
                calls.push_back(call);
                count += 1;
            }
            current += 1;
        }

        calls
    }

    /// Get a paginated slice of calls created by a specific address.
    /// Returns at most [`MAX_CALL_PAGE_SIZE`] calls starting from `start_id`.
    pub fn get_calls_by_creator_paginated(
        env: Env,
        creator: Address,
        start_id: u64,
        limit: u32,
    ) -> Vec<Call> {
        let mut calls = Vec::new(&env);
        let total_calls = get_call_counter(&env);
        let page_size = limit.min(MAX_CALL_PAGE_SIZE);

        if page_size == 0 {
            return calls;
        }

        let mut count = 0;
        let mut current = if start_id < 1 { 1 } else { start_id };

        while count < page_size && current <= total_calls {
            if let Some(call) = get_call(&env, current) {
                if call.creator == creator {
                    calls.push_back(call);
                    count += 1;
                }
            }
            current += 1;
        }

        calls
    }

    /// Get statistics for a specific call.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`] – `call_id` does not exist.
    pub fn get_call_stats(env: Env, call_id: u64) -> Result<CallStats, CallRegistryError> {
        let call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        let mut outcome_stake_counts = soroban_sdk::Map::new(&env);
        let mut total_stakes = 0;

        for i in 1..=call.outcome_count {
            let outcome_stakers = call.stakes.get(i).unwrap_or_else(|| soroban_sdk::Map::new(&env));
            let count = outcome_stakers.len();
            outcome_stake_counts.set(i, count);
            total_stakes += count;
        }

        Ok(CallStats {
            outcome_stakes: call.outcome_stakes,
            outcome_stake_counts,
            total_stakes,
        })
    }

    /// Get all calls a staker has participated in.
    pub fn get_staker_calls(env: Env, staker: Address) -> Vec<Call> {
        let call_ids = get_staker_calls(&env, &staker);
        let mut calls = Vec::new(&env);

        for call_id in call_ids.iter() {
            if let Some(call) = get_call(&env, call_id) {
                calls.push_back(call);
            }
        }

        calls
    }

    /// Get the stake amount a staker has on a specific call position.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`]    – `call_id` does not exist.
    /// * [`CallRegistryError::InvalidPosition`] – `position` ∉ [1, outcome_count].
    pub fn get_staker_stake(
        env: Env,
        call_id: u64,
        staker: Address,
        position: u32,
    ) -> Result<i128, CallRegistryError> {
        let call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;

        if position < 1 || position > call.outcome_count {
            return Err(CallRegistryError::InvalidPosition);
        }

        let outcome_stakers = call.stakes.get(position).unwrap_or_else(|| soroban_sdk::Map::new(&env));
        Ok(outcome_stakers.get(staker).unwrap_or(0))
    }

    /// Get the total stakes for each outcome of a call.
    /// # Errors
    /// * [`CallRegistryError::CallNotFound`] – `call_id` does not exist.
    pub fn get_outcome_stakes(env: Env, call_id: u64) -> Result<soroban_sdk::Map<u32, i128>, CallRegistryError> {
        let call = get_call(&env, call_id).ok_or(CallRegistryError::CallNotFound)?;
        Ok(call.outcome_stakes)
    }

    /// Get total number of calls created.
    pub fn get_call_count(env: Env) -> u64 {
        get_call_counter(&env)
    }

    /// Get contract-wide aggregated statistics.
    pub fn get_global_stats(env: Env) -> GlobalStats {
        storage::get_global_stats(&env)
    }
}
