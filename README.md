# docker-backup
Config:
```yaml
with:
    base_backup_dir: /tmp/postgres
    docker_cfg: |
    #all_containers: true # then the following configs only filter volumes
    #docker_host: unix:///var/run/docker.sock  # optional
    containers:
        - name: infisical-db
        commands:
            - outputFile: /tmp/postgres/pg_dump.sql
            #containerUser: root  # optional
            cmds:
                - pg_dumpall
                - -U
                - infisical
                - -c
```