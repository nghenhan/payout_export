
# CLI Tool for Binance Payouts

This CLI tool provides functionality for executing Binance payouts. It offers a simple interface to manage and process payouts efficiently.

## Installation

[Add installation instructions here]

## Usage

The main command of this CLI tool is `execute`. This command allows you to process Binance payouts with various options.

### Execute Command

The `execute` command is used to process Binance payouts. Here's the basic usage:

```
payout execute [OPTIONS]
```

#### Options

- `--currency <CURRENCY>`: Specify the currency for the payout (e.g., USDT, BTC)
- `--csv <CSV_FILE>`: Path to the CSV file containing payout details
- `--api-key <API_KEY>`: Your Binance API key
- `--api-secret <API_SECRET>`: Your Binance API secret
- `--notify-chat-id <CHAT_ID>`: Telegram chat ID for notifications
- `--notify-bot-token <BOT_TOKEN>`: Telegram bot token for notifications

#### Example

```
payout execute --currency USDT --csv payouts.csv --api-key your_api_key --api-secret your_api_secret --notify-chat-id 123456789 --notify-bot-token your_bot_token
```

### Local Environment Storage

This CLI tool includes a feature that saves command flags to a local environment file. This feature is designed for user convenience and enhanced security.

**Important Notes:**
- The environment file is stored locally on your machine.
- The stored information is never sent anywhere and remains on your local system.
- The environment file is located at `~/.payout/.env` (adjust the path based on your CLI tool's name).

When you run the `execute` command with flags, the CLI tool will save these flags to the local environment file. In subsequent runs, you can omit previously used flags, and the tool will use the saved values.

For example, after running the command with all flags once:

```
payout execute --currency USDT --csv new_payouts.csv
```

The tool will use the saved API key, API secret, and notification settings from the previous run, only updating the currency and CSV file path.

To update saved values, simply provide the new values as flags in your command.

## Security

Always ensure that you keep your API keys and secrets secure. Never share them or commit them to version control systems.

## Support

[Add support information here]

## License

[Add license information here]
