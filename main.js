function checkDockerCfg(dockerCfg) {
    if (
        dockerCfg === null ||
        typeof dockerCfg !== 'object' ||
        Array.isArray(dockerCfg) ||
        Object.getPrototypeOf(dockerCfg) !== Object.prototype
    ) {
        throw new Error('docker_cfg must be an object')
    }

    const jsonSchema = `
    {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ContainerConfig",
  "type": "object",
  "anyOf": [
    { "required": ["all_containers"] },
    { "required": ["containers"] }
  ],
  "properties": {
    "all_containers": {
      "type": "boolean",
      "description": "If true, the configuration applies to all containers."
    },
    "docker_host": {
      "type": "string",
      "description": "Docker daemon host URL. Optional."
    },
    "containers": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "volumes": {
            "type": "array",
            "items": { "type": "string" }
          },
          "commands": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "outputFile": { "type": "string" },
                "containerUser": { "type": "string" },
                "cmds": {
                  "type": "array",
                  "items": { "type": "string" },
                  "minItems": 1
                }
              },
              "required": ["outputFile", "cmds"]
            }
          }
        },
        "required": ["name"]
      }
    }
  }
}`
    core.validateJSONSchema(dockerCfg, jsonSchema)
}

function getVolumesFromContainer(container, containerCfg) {
    if (!container.mounts) {
      console.log(`Container has no mounts`);
      return [];
    }

    
    let volumes = []

    for (let mnt of container.mounts) {
        console.log(`Processing mount: type=${mnt.type}, name=${mnt.name}`);
        if (String(mnt.type).trim().toLowerCase() === 'volume' && mnt.name && mnt.name.length > 0) {
            volumes.push(mnt.name);
        }
    }

    console.log(`Found volumes: ${volumes.join(', ')}`);

    if (containerCfg && containerCfg.volumes) {
        volumes = volumes.filter(vol => containerCfg.volumes.includes(vol));
    }

    console.log(`Final volumes: ${volumes.join(', ')}`);

    return volumes;
}

function foundContainerCfg(cfg, containerName) {
    if (!cfg.containers) {
        return null;
    }
   
    return cfg.containers.find(c => c.name === containerName);
}

function doBackups(baseDir, cfg) {
    const ret = core.runCmd("mkdir", ["-p", baseDir]);
    if (ret.status !== 0) {
        throw new Error(`Failed to create backup directory ${baseDir}: ${ret.stderr}`);
    }
    let cli = core.newDockerCli(cfg.docker_host)
    console.log("Created Docker client with host:", cfg.docker_host || "default")
    let expectedContains = []
    if (cfg.all_containers) {
        console.log("Backing up all containers")
    } else if (cfg.containers && cfg.containers.length > 0) {
        console.log("Backing up specific containers:", cfg.containers.map(c => c.name).join(", "))
        expectedContains = cfg.containers.map( c => c.name);
    } else {
        console.log("No containers specified for backup")
        return;
    }

    // console.log("Pulling busybox:latest image...");
    // const output = cli.pullImage("busybox:latest");
    // console.log("Pull output:", output);
    // console.log("Finished pulling busybox:latest image");

    const containers = cli.listContainers({all: true})
    for(let con of containers) {
        const containerId = con.names ? con.names[0].replace(/^\//, '') : con.id;
        console.log("\nProcessing container: ", containerId);

        if (expectedContains.length > 0 && !expectedContains.includes(containerId)) {
            console.log("  Skipping container (not in expected list)");
            continue;
        }

        const containerCfg = foundContainerCfg(cfg, containerId);
        
        if (containerCfg && containerCfg.commands) {
            runDockerCommands(cli, containerId, con, containerCfg.commands);
        }

        const volumes = getVolumesFromContainer(con, containerCfg);
        if (volumes.length === 0) {
            console.log("  No volumes to backup, skipping");
            continue;
        }

        console.log("  Would backup volumes:", volumes);

        if (con.state === 'running') {
            console.log("  Container is running, stopping it...");
            cli.stopContainer(containerId);
        }

        for (const volume of volumes) {
            console.log("  Backing up volume:", volume);
            backupVolume(volume, cli, containerId, baseDir);
        }
        
    }
}

function backupVolume(volume, cli, containerId, baseDir) {
    console.log(`Backing up volume ${volume} for container ${containerId}`);
    let cmd = core.runCmd("docker", ["run", "--rm", "-v", `${baseDir}:/backup`, "-v", `${volume}:/data`, "busybox", "tar", "-czf", `/backup/${containerId}-${volume}.tar.gz`, "-C", "/data", "."])
    if (cmd.status != 0) {
      throw new Error("backup volume failed: " + cmd.stderr)
    }

    core.runCmd("ls", ["-la", `${baseDir}`]);
    console.log(`Backup completed for volume ${volume} of container ${containerId}`);
    console.log(`Backup file: ${baseDir}/${containerId}-${volume}.tar.gz`);
}

function backupVolume1(volume, cli, containerId, baseDir) {
    console.log(`Backing up volume ${volume}`);
    const cmd = [
      "tar", "-czf", `/backup/${containerId}-${volume}.tar.gz`, "-C", "/data", "."
    ]

    const options = {
      user: 'root',
      autoRemove: true,
      volumes: [
        `${volume}:/data`,
        `${baseDir}:/backup`
      ],
    }
    console.log("Backup command:", cmd.join(' '));
    console.log("Running backup with options:", JSON.stringify(options, null, 2));
    const output = cli.runImage("busybox:latest", cmd, options);
    console.log("Backup command output:", output);
}

function runDockerCommands(cli, containerId, container, commands) {
    console.log(`Running docker commands for container ${containerId}`);
    if (container.state !== 'running') {
        console.log(`  Container ${containerId} is not running, skipping commands`);
        return;
    }
    for (const cmd of commands) {
        console.log(`  Running command: ${cmd.cmds.join(' ')}`);
        console.log(`  Saving output to file: ${cmd.outputFile}`);
        let output = cli.containerExecToFile(containerId, cmd.containerUser || '', cmd.cmds, cmd.outputFile);

        console.log(`  Command output: ${output}`);
    }
}

function main() {
    console.log('start backup')
    let baseDir = env.get('base_backup_dir')
    let dockerCfg = env.get('docker_cfg')
    if (!dockerCfg) {
        throw new Error('docker_cfg is not set')
    }
    let cfg = core.parseYAML(dockerCfg)
    console.log("loaded docker config")

    checkDockerCfg(cfg)
    doBackups(baseDir, cfg)


}

main()