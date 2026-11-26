var e=`{
  "version": 1,
  "meta": {
    "name": "Three routers with OSPF",
    "createdAt": "2026-11-25T00:00:00.000Z",
    "updatedAt": "2026-11-25T00:00:00.000Z"
  },
  "devices": {
    "dev_otrR1": {
      "id": "dev_otrR1",
      "model": "router-2g2s",
      "position": {
        "x": 232,
        "y": 424
      },
      "powered": true,
      "ports": [
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/0",
          "mac": "5a:14:b9:f8:ef:0d"
        },
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/1",
          "mac": "ae:69:4e:8c:0a:9f"
        },
        {
          "kind": "serial",
          "id": "Serial0/0/0"
        },
        {
          "kind": "serial",
          "id": "Serial0/0/1"
        }
      ],
      "kind": "router",
      "config": {
        "hostname": "R1",
        "virtualInterfaces": {},
        "servicePasswordEncryption": false,
        "domainLookup": true,
        "unknownLines": [],
        "interfaces": {
          "GigabitEthernet0/0": {
            "shutdown": false,
            "ipv4": {
              "address": "192.168.1.1",
              "prefixLength": 24
            }
          },
          "GigabitEthernet0/1": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.12.1",
              "prefixLength": 30
            }
          },
          "Serial0/0/0": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.13.1",
              "prefixLength": 30
            },
            "clockRate": 64000
          },
          "Serial0/0/1": {
            "shutdown": true
          }
        },
        "subinterfaces": {},
        "lines": {
          "console": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "aux": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "vty": [
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            }
          ]
        },
        "staticRoutes": [],
        "ospf": {
          "processId": 1,
          "networks": [
            {
              "address": "192.168.1.0",
              "wildcard": "0.0.0.255",
              "area": 0
            },
            {
              "address": "10.0.12.0",
              "wildcard": "0.0.0.3",
              "area": 0
            },
            {
              "address": "10.0.13.0",
              "wildcard": "0.0.0.3",
              "area": 0
            }
          ],
          "passiveInterfaces": [
            "GigabitEthernet0/0"
          ],
          "routerId": "1.1.1.1"
        }
      }
    },
    "dev_otrR2": {
      "id": "dev_otrR2",
      "model": "router-4g",
      "position": {
        "x": 424,
        "y": 232
      },
      "powered": true,
      "ports": [
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/0",
          "mac": "46:78:77:6e:42:f5"
        },
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/1",
          "mac": "b2:ad:da:84:d3:40"
        },
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/2",
          "mac": "06:ab:aa:04:d3:05"
        },
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/3",
          "mac": "1e:82:32:bf:fd:52"
        }
      ],
      "kind": "router",
      "config": {
        "hostname": "R2",
        "virtualInterfaces": {},
        "servicePasswordEncryption": false,
        "domainLookup": true,
        "unknownLines": [],
        "interfaces": {
          "GigabitEthernet0/0": {
            "shutdown": false,
            "ipv4": {
              "address": "192.168.2.1",
              "prefixLength": 24
            }
          },
          "GigabitEthernet0/1": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.12.2",
              "prefixLength": 30
            }
          },
          "GigabitEthernet0/2": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.23.1",
              "prefixLength": 30
            }
          },
          "GigabitEthernet0/3": {
            "shutdown": true
          }
        },
        "subinterfaces": {},
        "lines": {
          "console": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "aux": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "vty": [
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            }
          ]
        },
        "staticRoutes": [],
        "ospf": {
          "processId": 1,
          "networks": [
            {
              "address": "192.168.2.0",
              "wildcard": "0.0.0.255",
              "area": 0
            },
            {
              "address": "10.0.12.0",
              "wildcard": "0.0.0.3",
              "area": 0
            },
            {
              "address": "10.0.23.0",
              "wildcard": "0.0.0.3",
              "area": 0
            }
          ],
          "passiveInterfaces": [
            "GigabitEthernet0/0"
          ],
          "routerId": "2.2.2.2"
        }
      }
    },
    "dev_otrR3": {
      "id": "dev_otrR3",
      "model": "router-2g2s",
      "position": {
        "x": 616,
        "y": 424
      },
      "powered": true,
      "ports": [
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/0",
          "mac": "76:22:7d:f9:f8:da"
        },
        {
          "kind": "gigabitEthernet",
          "id": "GigabitEthernet0/1",
          "mac": "ee:09:e0:fa:1e:fa"
        },
        {
          "kind": "serial",
          "id": "Serial0/0/0"
        },
        {
          "kind": "serial",
          "id": "Serial0/0/1"
        }
      ],
      "kind": "router",
      "config": {
        "hostname": "R3",
        "virtualInterfaces": {},
        "servicePasswordEncryption": false,
        "domainLookup": true,
        "unknownLines": [],
        "interfaces": {
          "GigabitEthernet0/0": {
            "shutdown": false,
            "ipv4": {
              "address": "192.168.3.1",
              "prefixLength": 24
            }
          },
          "GigabitEthernet0/1": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.23.2",
              "prefixLength": 30
            }
          },
          "Serial0/0/0": {
            "shutdown": false,
            "ipv4": {
              "address": "10.0.13.2",
              "prefixLength": 30
            }
          },
          "Serial0/0/1": {
            "shutdown": true
          }
        },
        "subinterfaces": {},
        "lines": {
          "console": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "aux": {
            "login": "none",
            "transportInput": {
              "ssh": true,
              "telnet": true
            }
          },
          "vty": [
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            },
            {
              "login": "password",
              "transportInput": {
                "ssh": true,
                "telnet": true
              }
            }
          ]
        },
        "staticRoutes": [],
        "ospf": {
          "processId": 1,
          "networks": [
            {
              "address": "192.168.3.0",
              "wildcard": "0.0.0.255",
              "area": 0
            },
            {
              "address": "10.0.23.0",
              "wildcard": "0.0.0.3",
              "area": 0
            },
            {
              "address": "10.0.13.0",
              "wildcard": "0.0.0.3",
              "area": 0
            }
          ],
          "passiveInterfaces": [
            "GigabitEthernet0/0"
          ],
          "routerId": "3.3.3.3"
        }
      }
    },
    "dev_otrPC1": {
      "id": "dev_otrPC1",
      "model": "pc",
      "position": {
        "x": 40,
        "y": 424
      },
      "powered": true,
      "ports": [
        {
          "kind": "fastEthernet",
          "id": "FastEthernet0",
          "mac": "62:aa:9a:2c:c5:e2"
        }
      ],
      "kind": "pc",
      "config": {
        "ipv4": {
          "mode": "static",
          "address": {
            "address": "192.168.1.10",
            "prefixLength": 24
          },
          "gateway": "192.168.1.1"
        },
        "hostname": "PC1"
      }
    },
    "dev_otrPC2": {
      "id": "dev_otrPC2",
      "model": "pc",
      "position": {
        "x": 424,
        "y": 40
      },
      "powered": true,
      "ports": [
        {
          "kind": "fastEthernet",
          "id": "FastEthernet0",
          "mac": "e6:02:1d:29:21:fb"
        }
      ],
      "kind": "pc",
      "config": {
        "ipv4": {
          "mode": "static",
          "address": {
            "address": "192.168.2.10",
            "prefixLength": 24
          },
          "gateway": "192.168.2.1"
        },
        "hostname": "PC2"
      }
    },
    "dev_otrPC3": {
      "id": "dev_otrPC3",
      "model": "pc",
      "position": {
        "x": 808,
        "y": 424
      },
      "powered": true,
      "ports": [
        {
          "kind": "fastEthernet",
          "id": "FastEthernet0",
          "mac": "b2:1f:56:da:90:69"
        }
      ],
      "kind": "pc",
      "config": {
        "ipv4": {
          "mode": "static",
          "address": {
            "address": "192.168.3.10",
            "prefixLength": 24
          },
          "gateway": "192.168.3.1"
        },
        "hostname": "PC3"
      }
    }
  },
  "links": {
    "lnk_otrR1R2": {
      "id": "lnk_otrR1R2",
      "a": {
        "device": "dev_otrR1",
        "port": "GigabitEthernet0/1"
      },
      "b": {
        "device": "dev_otrR2",
        "port": "GigabitEthernet0/1"
      },
      "cable": "crossover"
    },
    "lnk_otrR2R3": {
      "id": "lnk_otrR2R3",
      "a": {
        "device": "dev_otrR2",
        "port": "GigabitEthernet0/2"
      },
      "b": {
        "device": "dev_otrR3",
        "port": "GigabitEthernet0/1"
      },
      "cable": "crossover"
    },
    "lnk_otrR1R3": {
      "id": "lnk_otrR1R3",
      "a": {
        "device": "dev_otrR1",
        "port": "Serial0/0/0"
      },
      "b": {
        "device": "dev_otrR3",
        "port": "Serial0/0/0"
      },
      "cable": "serial",
      "dce": "a"
    },
    "lnk_otrPC1R1": {
      "id": "lnk_otrPC1R1",
      "a": {
        "device": "dev_otrPC1",
        "port": "FastEthernet0"
      },
      "b": {
        "device": "dev_otrR1",
        "port": "GigabitEthernet0/0"
      },
      "cable": "crossover"
    },
    "lnk_otrPC2R2": {
      "id": "lnk_otrPC2R2",
      "a": {
        "device": "dev_otrPC2",
        "port": "FastEthernet0"
      },
      "b": {
        "device": "dev_otrR2",
        "port": "GigabitEthernet0/0"
      },
      "cable": "crossover"
    },
    "lnk_otrPC3R3": {
      "id": "lnk_otrPC3R3",
      "a": {
        "device": "dev_otrPC3",
        "port": "FastEthernet0"
      },
      "b": {
        "device": "dev_otrR3",
        "port": "GigabitEthernet0/0"
      },
      "cable": "crossover"
    }
  },
  "annotations": {
    "ann_otrarea": {
      "id": "ann_otrarea",
      "kind": "note",
      "position": {
        "x": 600,
        "y": 40
      },
      "text": "Every router runs OSPF process 1 in area 0, with router IDs 1.1.1.1, 2.2.2.2 and 3.3.3.3. The LAN ports are passive: no hellos go to the PCs.",
      "width": 192,
      "color": "amber"
    },
    "ann_otrcost": {
      "id": "ann_otrcost",
      "kind": "note",
      "position": {
        "x": 328,
        "y": 528
      },
      "text": "Each Gigabit link costs 1 and the serial link 64, so R1 reaches R3’s LAN through R2 at cost 3 rather than straight across at 65.",
      "width": 192,
      "color": "amber"
    }
  }
}
`;export{e as default};