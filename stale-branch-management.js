require('dotenv').config()
const program = '-- stale-branch-management --'
const argv = require('yargs').argv
const fs = require('fs')
const csv = require('csv-parser')
let { graphql } = require('@octokit/graphql')
graphql = graphql.defaults({
  baseUrl: process.env.GITHUB_ENDPOINT,
  headers: {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`
  }
})
const { Octokit } = require('@octokit/rest')
const { retry } = require('@octokit/plugin-retry')
const { throttling } = require('@octokit/plugin-throttling')
const MyOctokit = Octokit.plugin(retry, throttling)
const githubOctokit = new MyOctokit({
  auth: process.env.GITHUB_TOKEN,
  baseUrl: process.env.GITHUB_ENDPOINT,
  throttle: {
    onRateLimit: (retryAfter, options) => {
      githubOctokit.log.warn(
        `[${new Date().toISOString()}] ${program} Request quota exhausted for request, will retry in ${retryAfter}`
      )
      return true
    },
    onAbuseLimit: (retryAfter, options) => {
      githubOctokit.log.warn(
        `[${new Date().toISOString()}] ${program} Abuse detected for request, will retry in ${retryAfter}`
      )
      return true
    }
  }
})

const outputBaseFolder = process.env.OUTPUT_FOLDER

// Full path and name of output file to create
const outputFile = `${outputBaseFolder}/stale-branches-report-${Date.now()}.csv`
let numStale = 0

if (argv.delete && argv.csv) {
  deleteStaleBranches()
} else {
  createCSV()
  getStaleBranches()
}

async function getStaleBranches () {
  let paginationOrg = null
  let paginationRepo = null
  let paginationRef = null

  const query =
    `query GetBranches ($enterprise: String! $cursorOrg: String $cursorRepo: String $cursorRef: String) {
  enterprise(slug: $enterprise) {
    organizations(first:1 after:$cursorOrg) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        login
        repositories(first:50 after:$cursorRepo) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            name
            defaultBranchRef {
              name
            }
            refs(first:25 after:$cursorRef refPrefix:"refs/heads/") {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                name
                target {
                  ... on Commit {
                    author { user { login } }
                    committedDate
                  }
                }
                branchProtectionRule {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
}`
  try {
    let currentOrg = null
    let hasNextPageOrg = false
    let currentRepo = null
    let hasNextPageRepo = false
    let hasNextPageRef = false
    let getBranches = null
    outer: do { // eslint-disable-line
      do {
        do {
          try {
            getBranches = await graphql({
              query,
              enterprise: process.env.ENTERPRISE_SLUG,
              cursorOrg: paginationOrg,
              cursorRepo: paginationRepo,
              cursorRef: paginationRef
            })
          } catch (err) {
            if (err.message.indexOf('IP allow list enabled') >= 0) {
              paginationOrg = (err.data.enterprise.organizations.pageInfo.endCursor)
              const errOrg = /Although you appear to have the correct authorization credentials, the `(?<org_name>[^`]+)` organization/.exec(err.message).groups.org_name
              console.error(`WARN: IP Allow List enabled for Org: "${errOrg}", unable to access via this integration`)
              continue outer // eslint-disable-line
            } else {
              console.error(`ERR: Error in ${program}\n ${JSON.stringify(err, null, 2)}`)
              process.exit(1)
            }
          }
          hasNextPageOrg = getBranches.enterprise.organizations.pageInfo.hasNextPage
          const orgsObj = getBranches.enterprise.organizations.nodes

          for (const org of orgsObj) {
            currentOrg = org
            const orgName = org.login
            console.log(`Checking repos for Org: "${orgName}"`)
            const reposObj = org.repositories.nodes
            hasNextPageRepo = org.repositories.pageInfo.hasNextPage

            for (const repo of reposObj) {
              currentRepo = repo
              const repoName = repo.name
              let repoDefaultBranch = null
              console.log(`  Checking branches for Repo: "${orgName}/${repoName}"`)
              if (repo.defaultBranchRef !== null) {
                repoDefaultBranch = repo.defaultBranchRef.name
              } else {
                continue
              }
              const branchesObj = repo.refs.nodes
              hasNextPageRef = repo.refs.pageInfo.hasNextPage

              for (const branch of branchesObj) {
                const branchName = branch.name
                console.log(`    Checking Branch: "${branchName}" for Repo: "${orgName}/${repoName}"`)
                const isbranchProtected = (branch.branchProtectionRule !== null)
                let author = branch.target.author.email
                if (branch.target.author.user) {
                  author = branch.target.author.user.login
                }
                const lastUpdated = branch.target.committedDate
                const canDeleteBranch = (branchName !== repoDefaultBranch && !isbranchProtected)
                if (canDeleteBranch && isBranchStale(lastUpdated)) {
                  console.log(`      Branch: "${branchName}" on Repo: "${orgName}/${repoName}" is stale: Adding to report`)
                  addToCSV(orgName, repoName, branchName, author, lastUpdated)
                  numStale++
                } else {
                  console.log(`      Branch: ${branchName} on Repo: "${orgName}/${repoName}" is protected or not stale: ignoring`)
                }
              }
              if (hasNextPageRef) {
                paginationRef = currentRepo.refs.pageInfo.endCursor
              } else {
                paginationRef = null
              }
            }
          }
        } while (hasNextPageRef)
        if (hasNextPageRepo) {
          paginationRepo = currentOrg.repositories.pageInfo.endCursor
        } else {
          paginationRepo = null
        }
      } while (hasNextPageRepo)
      if (hasNextPageOrg) {
        paginationOrg = getBranches.enterprise.organizations.pageInfo.endCursor
      } else {
        paginationOrg = null
      }
    } while (hasNextPageOrg)
    console.log(`
      \n------------------------------------------------------
      \n--- Report Complete ---
      \n${numStale} stale branches found`)
    if (numStale > 0) {
      console.log(`\nReview ${outputFile} for results
        \nTo delete stale branches, run:\n  node stale-branch-management.js --delete --csv ${outputFile}\n`)
    }
  } catch (error) {
    console.error('Request failed:', error.request)
    console.error(error.message)
    console.error(error)
  }
}

function createCSV () {
  if (!fs.existsSync(outputBaseFolder)) {
    fs.mkdirSync(outputBaseFolder)
  }
  const header = 'Organization,Repository,Branch,Author,LastUpdated'
  fs.appendFileSync(outputFile, header + '\n', err => {
    if (err) return console.log(err)
  })
}

function addToCSV (org, repo, branch, author, lastUpdated) {
  fs.appendFileSync(outputFile, `${org},${repo},${branch},${author},${lastUpdated}\n`)
}

function deleteStaleBranches () {
  const csvPipe = fs.createReadStream(argv.csv).pipe(csv())
  const rowArray = []
  let org = ''
  let repo = ''
  let branch = ''
  let numDeleted = 0
  csvPipe.on('data', async (row) => {
    try {
      const rowData = { Org: row.Organization, Repo: row.Repository, Branch: row.Branch, Author: row.Author, lastUpdated: row.lastUpdated }
      rowArray.push(rowData)
    } catch (err) {
      console.log(err)
    }
  }).on('end', async () => {
    for (const row in rowArray) {
      org = rowArray[row].Org
      repo = rowArray[row].Repo
      branch = rowArray[row].Branch
      try {
        await githubOctokit.git.deleteRef({
          owner: org,
          repo,
          ref: `heads/${branch}`
        })
        console.log(`Deleted Branch: ${branch} from Repo: ${org}/${repo}`)
        numDeleted++
      } catch (err) {
        console.error(err)
      }
    }
    console.log(`
      \n------------------------------------------------------
      \n--- Stale Branch Delete Complete ---
      \n${numDeleted} branches deleted`)
    if (numDeleted > 0) {
      console.log(`\nReview ${argv.csv} for a list of which branches were deleted\n`)
    }
  })
}

function isBranchStale (lastUpdated) {
  const staleDays = process.env.STALE_DAYS
  const dateUpdated = new Date(lastUpdated).getTime()
  // Covnert staleDays to milliseconds
  const staleDate = (Date.now() - (staleDays * 24 * 60 * 60 * 1000))
  return (dateUpdated < staleDate)
}
