use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{anyhow, bail, Context as _, Result};
use log::{error, info, warn};
use scale::{Decode, Encode};

use pherry::{
    headers_cache as cache,
    types::{phaxt::ChainApi, Header},
};

use crate::{
    db::{CacheDB, Metadata},
    BlockNumber, Serve,
};

pub(crate) async fn run(db: CacheDB, config: Serve) -> Result<()> {
    let mut metadata = db.get_metadata()?.unwrap_or_default();
    let mut next_header = match metadata.higest.header {
        Some(highest) => highest + 1,
        None => config.genesis_block,
    };
    let mut next_para_header = metadata
        .higest
        .para_header
        .map(|i| i + 1)
        .unwrap_or_default();
    let mut next_delta = metadata
        .higest
        .storage_changes
        .map(|i| i + 1)
        .unwrap_or_default();

    GENESIS.store(config.genesis_block, Ordering::Relaxed);

    loop {
        if let Err(err) = Crawler::grab(
            &config,
            &db,
            &mut metadata,
            &mut next_header,
            &mut next_para_header,
            &mut next_delta,
        )
        .await
        {
            error!("Error: {err:?}");
        }
        sleep(config.interval).await;
    }
}

struct Crawler<'c> {
    config: &'c Serve,
    db: &'c CacheDB,
    metadata: &'c mut Metadata,
    api: ChainApi,
    para_api: ChainApi,
    next_header: Option<&'c mut BlockNumber>,
    next_para_header: Option<&'c mut BlockNumber>,
    next_delta: Option<&'c mut BlockNumber>,
}

impl<'c> Crawler<'c> {
    async fn grab<'p>(
        config: &'c Serve,
        db: &'c CacheDB,
        metadata: &'c mut Metadata,
        next_header: &'c mut BlockNumber,
        next_para_header: &'c mut BlockNumber,
        next_delta: &'c mut BlockNumber,
    ) -> Result<()> {
        info!("Connecting to {}...", config.node_uri);
        let api = pherry::subxt_connect(&config.node_uri)
            .await
            .context(format!("Failed to connect to {}", config.node_uri))?;
        info!("Connecting to {}...", config.para_node_uri);
        let para_api = pherry::subxt_connect(&config.para_node_uri)
            .await
            .context(format!("Failed to connect to {}", config.para_node_uri))?;
        if !metadata.genesis.contains(&config.genesis_block) {
            info!("Fetching genesis at {}", config.genesis_block);
            let genesis = cache::fetch_genesis_info(&api, config.genesis_block)
                .await
                .context("Failed to fetch genesis info")?;
            db.put_genesis(config.genesis_block, &genesis.encode())?;
            metadata.put_genesis(config.genesis_block);
            db.put_metadata(metadata)?;
            info!("Got genesis at {}", config.genesis_block);
        }
        Self {
            config,
            db,
            metadata,
            api,
            para_api,
            next_header: config.grab_headers.then_some(next_header),
            next_para_header: config.grab_para_headers.then_some(next_para_header),
            next_delta: config.grab_storage_changes.then_some(next_delta),
        }
        .run()
        .await
    }

    async fn finalized_header_number(&self, para: bool) -> Result<BlockNumber> {
        let api = if para { &self.para_api } else { &self.api };
        let hash = api.rpc().finalized_head().await?;
        let header = api.rpc().header(Some(hash)).await?;
        let header_number = header.map(|h| h.number).unwrap_or_default();
        Ok(header_number)
    }

    async fn grab_headers(&mut self) -> Result<()> {
        let latest_finalized = self.finalized_header_number(false).await?;
        let Some(next_header) = self.next_header.as_deref_mut() else {
            return Ok(());
        };
        info!("Relaychain finalized: {latest_finalized}");
        if latest_finalized < *next_header + self.config.justification_interval {
            info!("No enough relaychain headers in node");
            return Ok(());
        }

        info!("Grabbing headers start from {next_header}...");
        cache::grab_headers(
            &self.api,
            &self.para_api,
            *next_header,
            u32::MAX,
            self.config.justification_interval,
            |info| {
                if info.justification.is_some() {
                    info!("Got justification at {}", info.header.number);
                    LATEST_JUSTFICATION.store(info.header.number as _, Ordering::Relaxed);
                }
                self.db
                    .put_header(info.header.number, &info.encode())
                    .context("Failed to put record to DB")?;
                self.metadata.update_header(info.header.number);
                self.db
                    .put_metadata(self.metadata)
                    .context("Failed to update metadata")?;
                *next_header = info.header.number + 1;
                Ok(())
            },
        )
        .await
        .context("Failed to grab headers from node")?;
        Ok(())
    }

    async fn grab_para_headers(&mut self) -> Result<()> {
        let latest_finalized = self.finalized_header_number(true).await?;
        let Some(next_para_header) = self.next_para_header.as_deref_mut() else {
            return Ok(());
        };
        if latest_finalized < *next_para_header {
            return Ok(());
        }
        let count = latest_finalized - *next_para_header + 1;
        info!("Grabbing {count} parachain headers start from {next_para_header}...");
        cache::grab_para_headers(&self.para_api, *next_para_header, count, |info| {
            self.db
                .put_para_header(info.number, &info.encode())
                .context("Failed to put record to DB")?;
            self.metadata.update_para_header(info.number);
            self.db
                .put_metadata(self.metadata)
                .context("Failed to update metadata")?;
            *next_para_header = info.number + 1;
            Ok(())
        })
        .await
        .context("Failed to grab para headers from node")?;
        Ok(())
    }

    async fn grab_storage_changes(&mut self) -> Result<()> {
        let latest_finalized = self.finalized_header_number(true).await?;
        let Some(next_delta) = self.next_delta.as_deref_mut() else {
            return Ok(());
        };
        if latest_finalized < *next_delta {
            return Ok(());
        }
        let count = latest_finalized - *next_delta + 1;
        info!("Grabbing {count} storage changes start from {next_delta}...",);
        cache::grab_storage_changes(
            &self.para_api,
            *next_delta,
            count,
            self.config.grab_storage_changes_batch,
            |info| {
                self.db
                    .put_storage_changes(info.block_header.number, &info.encode())
                    .context("Failed to put record to DB")?;
                self.metadata
                    .update_storage_changes(info.block_header.number);
                self.db
                    .put_metadata(self.metadata)
                    .context("Failed to update metadata")?;
                *next_delta = info.block_header.number + 1;
                Ok(())
            },
        )
        .await
        .context("Failed to grab storage changes from node")?;
        Ok(())
    }

    async fn continue_check_headers(&mut self) -> Result<()> {
        let db = self.db;
        let config = self.config;
        let metadata = &mut *self.metadata;

        let relay_start = metadata.checked.header.unwrap_or(config.genesis_block);
        let relay_end = metadata
            .recent_imported
            .header
            .unwrap_or(0)
            .min(relay_start + config.check_batch);
        if relay_start < relay_end {
            check_and_fix_headers(db, config, "relay", relay_start, Some(relay_end), None).await?;
            metadata.checked.header = Some(relay_end);
            db.put_metadata(metadata)
                .context("Failed to update metadata")?;
        }

        let para_start = metadata.checked.para_header.unwrap_or(0);
        let para_end = metadata
            .recent_imported
            .para_header
            .unwrap_or(0)
            .min(para_start + config.check_batch);
        if para_start < para_end {
            check_and_fix_headers(db, config, "para", para_start, Some(para_end), None).await?;
            metadata.checked.para_header = Some(para_end);
            db.put_metadata(metadata)
                .context("Failed to update metadata")?;
        }
        Ok(())
    }

    async fn run(&mut self) -> Result<()> {
        loop {
            self.grab_headers().await?;
            self.grab_para_headers().await?;
            self.grab_storage_changes().await?;
            if let Err(err) = self.continue_check_headers().await {
                error!("Error fixing headers: {err:?}");
            }
            sleep(self.config.interval).await;
        }
    }
}

static GENESIS: AtomicU32 = AtomicU32::new(u32::MAX);
static LATEST_JUSTFICATION: AtomicU32 = AtomicU32::new(u32::MAX);

pub(crate) fn genesis_block() -> BlockNumber {
    GENESIS.load(Ordering::Relaxed)
}

pub(crate) fn latest_justification() -> BlockNumber {
    LATEST_JUSTFICATION.load(Ordering::Relaxed)
}

pub(crate) fn update_404_block(block: BlockNumber) {
    LATEST_JUSTFICATION.fetch_min(block.saturating_sub(1), Ordering::Relaxed);
}

async fn sleep(secs: u64) {
    info!("Sleeping for {secs} seconds...");
    tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
}

pub(crate) async fn check_and_fix_headers(
    db: &CacheDB,
    config: &Serve,
    what: &str,
    from: BlockNumber,
    to: Option<BlockNumber>,
    count: Option<BlockNumber>,
) -> Result<String> {
    let to = to.unwrap_or(from + count.unwrap_or(1));
    info!("Checking {what} headers from {from} to {to}");
    if to <= from {
        bail!("Invalid range");
    }
    let result = match what {
        "relay" => db.get_header(from),
        "para" => db.get_para_header(from),
        _ => bail!("Unknown check type {}", what),
    };
    let Some(prev) = result else {
        bail!("Header {} not found", from);
    };
    let Ok(mut prev) = decode_header(&prev) else {
        bail!("Failed to decode header {}", from);
    };
    let mut mismatches = 0;
    let mut codec_errors = 0;
    for block in (from + 1)..=to {
        match what {
            "relay" => {
                let cur_header = db
                    .get_header(block)
                    .ok_or_else(|| anyhow!("Header {} not found", block))?;
                let mut cur_header = match decode_header(&cur_header) {
                    Ok(cur_header) => cur_header,
                    Err(_) => {
                        codec_errors += 1;
                        regrab_header(db, config, block).await?
                    }
                };
                if prev.hash() != cur_header.parent_hash {
                    mismatches += 1;
                    prev = regrab_header(db, config, prev.number)
                        .await
                        .context("Failed to regrab header")?;
                    cur_header = regrab_header(db, config, cur_header.number).await?;
                    if prev.hash() != cur_header.parent_hash {
                        bail!("Cannot fix mismatch at {block}");
                    }
                }
                prev = cur_header;
            }
            "para" => {
                let cur_header = db
                    .get_para_header(block)
                    .ok_or_else(|| anyhow!("Parachain header {} not found", block))?;
                let mut cur_header = match decode_header(&cur_header) {
                    Ok(cur_header) => cur_header,
                    Err(_) => {
                        codec_errors += 1;
                        regrab_para_header(db, config, block).await?
                    }
                };
                if prev.hash() != cur_header.parent_hash {
                    mismatches += 1;
                    prev = regrab_para_header(db, config, prev.number)
                        .await
                        .context("Failed to regrab parachain header")?;
                    cur_header = regrab_para_header(db, config, cur_header.number).await?;
                    if prev.hash() != cur_header.parent_hash {
                        bail!("Cannot fix mismatch at {block}");
                    }
                }
                prev = cur_header;
            }
            _ => bail!("Unknown check type {}", what),
        }
    }
    let response = if mismatches > 0 || codec_errors > 0 {
        format!("Checked blocks from {from} to {to}, {mismatches} mismatches, {codec_errors} codec errors")
    } else {
        format!("Checked blocks from {from} to {to}, All OK")
    };
    info!("{}", response);
    Ok(response)
}

fn decode_header(data: &[u8]) -> Result<Header> {
    let header = Header::decode(&mut &data[..]).context("Failed to decode header")?;
    Ok(header)
}

async fn regrab_header(db: &CacheDB, config: &Serve, number: BlockNumber) -> Result<Header> {
    if !config.grab_headers {
        warn!("Trying to regrab header {number} while grab headers disabled");
        bail!("Grab headers disabled");
    }
    info!("Regrabbing header {}", number);
    let api = pherry::subxt_connect(&config.node_uri)
        .await
        .context(format!("Failed to connect to {}", config.node_uri))?;
    let para_api = pherry::subxt_connect(&config.para_node_uri)
        .await
        .context(format!("Failed to connect to {}", config.para_node_uri))?;
    let mut header = None;
    cache::grab_headers(&api, &para_api, number, 1, 1, |info| {
        db.put_header(info.header.number, &info.encode())
            .context("Failed to put record to DB")?;
        header = Some(info.header);
        Ok(())
    })
    .await?;
    header.ok_or(anyhow!("Failed to grab header"))
}

async fn regrab_para_header(db: &CacheDB, config: &Serve, number: BlockNumber) -> Result<Header> {
    if !config.grab_para_headers {
        warn!("Trying to regrab paraheader {number} while grab headers disabled");
        bail!("Grab parachain headers disabled");
    }
    info!("Regrabbing parachain header {}", number);
    let para_api = pherry::subxt_connect(&config.para_node_uri)
        .await
        .context(format!("Failed to connect to {}", config.para_node_uri))?;
    let mut grabed = None;
    cache::grab_para_headers(&para_api, number, 1, |header| {
        db.put_para_header(header.number, &header.encode())
            .context("Failed to put record to DB")?;
        grabed = Some(header);
        Ok(())
    })
    .await?;

    grabed.ok_or(anyhow!("Failed to grab parachain header"))
}
