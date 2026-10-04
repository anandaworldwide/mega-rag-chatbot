# Crawler schedule

The production crawler runs on one Linux VM. systemd starts each crawl from a timer. The host stores logs in the systemd journal.

Read the logs with this command:

```bash
journalctl -u ananda-crawler.service -n 100 --no-pager
```

Install the VM from [CLOUD-DEPLOYMENT.md](CLOUD-DEPLOYMENT.md). Operate the VM from [deploy/vm/README.md](deploy/vm/README.md).

The macOS LaunchAgent on the laptop is out of service. Do not load a plist from `~/Library/LaunchAgents`.
