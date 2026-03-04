## Tailscale internal DNS configuration

```
sudo apt instal dnsmasq
```

*`/etc/dnsmasq.d/tailscale-internal.conf`*

```
# Listen only on localhost and the Tailscale interface address.
listen-address=127.0.0.1,100.102.197.111
bind-interfaces

# Basic hygiene.
domain-needed
bogus-priv

# Forward everything except our private zone to public resolvers.
no-resolv
server=1.1.1.1
server=1.0.0.1

# Declare our private zone as local.
local=/internal.asymptoticsecurity.com/

# Static records.
address=/notes-api.internal.asymptoticsecurity.com/100.102.197.111
address=/notes.internal.asymptoticsecurity.com/100.102.197.111
```

```
sudo systemctl restart dnsmasq
sudo systemctl enable dnsmasq
```

Testing

```
dig internal.asymptoticsecurity.com
```

## Configuring in Tailscale Admin Console

![alt text](assets/TAILSCALE-image.png)