# Stale Branch Management for GitHub Enterprise

This Node script can be used on GitHub Enterprise (Server or Cloud) to list stale branches for repositories owned by the Enterprise. It will return a `.csv` file with a report of *all branches* that are stale (defined by the `.env`), and who the latest *commit_author* is. It **requires** a GitHub Personal Access Token (PAT) with the following scopes on a user that is an **organization owner** for every organization in the Enterprise:
- `admin:enterprise`
- `admin:org`
- `admin:repo`

## How to run

- Install the node modules
  - `npm install`
- Create `.env` with needed variables based on `.env.example`
  - The `OUTPUT_FOLDER` specified will be created if needed, and the generated `.csv` will be within
- Run the script:
  - `node stale-branch-management.js`
- Once your report has been created, you can pass in a flag to automatically delete the stale branches in the report:
  - `node stale-branch-management.js --delete --csv <path to .csv>`
- You can log the output of the terminal to a file:
  - `node stale-branch-management.js | tee output_file`

## Report layout

Once the script has run to completion, you will be presented with a report of all stale branches in the format below:

`Filename: stale-branches-report-<epoch_timestamp>.csv`

```csv
Organization,Repository,Branch,Author,LastUpdated
org1,repo1,feature1,IAmHughes,2020-01-14T19:48:46Z
org1,repo2,dev1,jwiebalk,2020-02-18T13:27:31Z
org2,repo1,newFeature,octocat,2019-07-11T15:54:22Z
org2,repo2,testBranch,jwiebalk,2020-07-25T19:47:17Z
someOrg,someRepo,someBranch,someAuthor,someDate
...
```

## Caveats

- This script requires that the `GITHUB_TOKEN` provided have the scopes listed above, and the user creating the token needs to be an organization owner of **every** organization in the Enterprise to get a complete report.
  - If the `GITHUB_TOKEN` does not have `organization owner` access, the end report will not include the organization
- If the Enterprise or an Organization within the Enterprise has an [IP Allow List](https://docs.github.com/en/github/setting-up-and-managing-organizations-and-teams/managing-allowed-ip-addresses-for-your-organization) enabled, the machine running this script will need to be allowed access, otherwise it will skip the Organization(s) or the entire Enterprise
- This will only report the Enterprise Owned repositories, not personal repositories.
