# spacemon

**A Filecoin Space Monitor**

## About

`spacemon` is a tool for monitoring the Filecoin network. Currently it is designed to collect the builtin-actor events from the `GetActorEventsRaw` Lotus API, validate, and structure them locally for consumption as nicely schema'd JSON files. Further detail is collected for the DDO (Direct Data Onboarding) specific events, `sector-activated` and `sector-updated` to monitor and understand data that is onboarded to Filecoin that _does not_ use the standard storage market actor. This is a new feature since Network Version 22 (nv22) and new tooling needed to be developed to collect and analyse data onboarded this way.

The output of this data is regularly compiled and uploaded for analysis at <https://observablehq.com/@rvagg/filecoin-ddo-stats>. However there are no guarantees that this uploaded data will continue to be made available! Please install and run your own instance of this if you want the data for yourself.

## Installation & Usage

This is not published to npm, please clone the repository and install from that.

```bash
npm install
# start a long-running mainnet collector
npm run collect-mainnet
# alternatively, compile DDO-specific data from collected data into a single JSON file
npm run compile-ddo-mainnet
```

`collect-calibnet` and `compile-ddo-calibnet` are also available for the calibration network.

These commands assume configuration files in the current working directory: `mainnet-config.json` and `calibnet-config.json`. You can specify a different configuration file by passing it as an argument when executing `spacemon.js` directly rather than via `npm`: e.g. `node /path/to/spacemon/spacemon.js collect /path/to/config.json`, and `node /path/to/spacemon/spacemon.js compile-ddo /path/to/config.json`.

## Configuration

```json
{
  "network": "mainnet",
  "lotusHttpRpc": "http://localhost:1234/rpc/v1",
  "lotusBackupHttpRpc": "https://api.zondax.ch/fil/node/mainnet/rpc/v1",
  "eventTypes": ["sector-activated", "sector-updated"],
  "maxFilters": 10000,
  "storePath": "./store",
  "apiCachePath": "./api-cache",
  "startEpoch": 3855360
}
```

* `network`: One of `"mainnet"` or `"calibnet"`
* `lotusHttpRpc`: The URL of the Lotus node's HTTP RPC endpoint. The Lotus node should have the following config options:
  * `Events.EnableActorEventsAPI` set to `true`
  * `Events.DisableRealTimeFilterAPI` unset or set to `false`
  * `Events.DisableHistoricFilterAPI` unset or set to `false`
  * `Events.MaxFilters` set to a high number, which matches the `maxFilters` value in the `spacemon` config
* `lotusBackupHttpRpc`: A backup Lotus node HTTP RPC endpoint. This could be the same RPC endpoint but it's used for `StateSearchMsg` which has been seen to occasionally be flaky in some (as yet understood) situations while having a secondary node available for this call has been seen to be more reliable.
* `eventTypes`: An array of event types to collect. Currently only `"sector-activated"` and `"sector-updated"` have additional processing associated with them, but all builtin actor events can be specified here and they will be properly collected, validated and formatted for later consumption. Leave this empty or omit to collect all builtin actor events.
* `maxFilters`: This should be set to the same value as `Events.MaxFilters` in the Lotus node config. By default in Lotus this is 10000. Unfortunately, to collect all builtin-actor events, this number needs to be increased because there have already been some epochs with more than 10000 builtin actor events. This number is used to check against the returned list size, if it matches then Spacemon knows it has received the maximum results so will narrow down its epoch range. But this can reach an epoch range of `1` in which case we can't properly collect all events.
* `storePath`: The path where the collected data will be stored. This should be a directory that is writable by the user running the `spacemon` process.
* `apiCachePath`: The path where the API cache will be stored. This should be a directory that is writable by the user running the `spacemon` process.
* `startEpoch`: The epoch from which to start collecting data. This should be set no earlier than the epoch in which the Lotus node started collecting actor events; otherwise the actor events database will not be populated for the epoch in question. Set to `0` to start from the Network Version 22 (nv22) epoch for the network in question; i.e. collect _all_ builtin actor events for that network because they started being produced from that epoch.

## Data

The most interesting data collected by Spacemon will be available in the store directory, under a subdirectory with the network name, e.g. `store/mainnet/`.

Data is stored in two forms:

* `raw/`: the raw data returned by `GetActorEventsRaw`.
* `event/`: the structured and validated data.

In both subdirectories, events are grouped in to per-day files. Each file has `startEpoch-endEpoch.json` as its name. The files start from the `startEpoch` in the configuration file and increment each `2880` epochs (a day). The last file is continually appended to until it reaches `2880` when a new file is started.

The files are NDJSON (newline-delimited JSON) format, with each line being a JSON object representing an event. There are no trailing commas on each line and the file does *not* begin and end with `[` and `]` respectively. So it cannot be parsed as a single JSON blob.

The `raw` events are log-style, CBOR encoded, so are not very friendly to parse. The parsed `event` formats use the IPLD schemas found in [builtin-actor-events-schemas.ipldsch](./builtin-actor-events-schemas.ipldsch) to validate and structure the data. The event data itself is nested inside a larger object of the form:

```json
{
  "type": "EVENT TYPE",
  "event": {
    "EVENT DATA": "HERE"
  },
  "emitter": "EMITTER ADDRESS",
  "reverted": false,
  "height": 1234567,
  "tipsetKey": [
    "CIDS OF THE TIPSET"
  ],
  "msgCid": "CID OF THE MESSAGE",
}
```

Note that currently Spacemon will not fetch data past finality, that is `900` epochs prior to the current epoch. So there should not be any `"reverted": true` events in the data, but the data will also always be at least 4.5 hours old.

### DDO

Using the `compile-ddo` command, the event data will be further compiled down into a subset of events in a `compiled-ddo/` directory. They are then packaged into a single `compiled-ddo.json` file which is has one event per line, but also has trailling commas and `[` and `]` at the start and end of the file so it can be parsed as a single JSON blob.

## Systemd Services

To run in systemd, create a service file like the following:

**spacemon-collect-mainnet.service**

```systemd
[Unit]
Description=Spacemon Collect
After=network.target

[Service]
User=rvagg
WorkingDirectory=/path/to/workingdir
ExecStart=/path/to/node /path/to/spacemon/spacemon.js collect /path/to/workingdir/config.json
Restart=always

[Install]
WantedBy=multi-user.target
```

For the DDO compilation, I have two additional Systemd configs. One to compile the DDO data and then upload it to my S3 bucket:

**spacemon-compile-upload.service**

```systemd
[Unit]
Description=Spacemon Compile and Upload
After=network.target

[Service]
User=rvagg
WorkingDirectory=/path/to/workingdir
ExecStart=/bin/bash -c '/path/to/node /path/to/spacemon/spacemon.js compile-ddo config.json && /path/to/aws --profile aws-profile-name s3 sync store/mainnet/ s3://s3-bucket --exclude "*" --include "compiled-ddo.json" --acl public-read --size-only'
```
  
And a timer for that service:

**spacemon-compile-upload.timer**

```systemd
[Unit]
Description=Run Spacemon Compile and Upload every 60 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=60min
Unit=spacemon-compile-upload.service

[Install]
WantedBy=timers.target
```

## License

Licensed under Apache-2.0, see [LICENSE](./LICENSE) for details.

