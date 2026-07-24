import { describe, expect, test } from "bun:test"
import { GitHubProjectDirectory } from "../../src/integrations/github-project-directory"
import { RepositoryDirectoryError } from "../../src/integrations/repository-directory"

describe("GitHub project directory", () => {
  test("normalizes the user and App permission intersection into lobby access", async () => {
    const requests: Request[] = []
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/user/installations") {
        return Response.json({
          installations: [
            {
              id: 44,
              account: {
                id: 7,
                login: "acme",
                type: "Organization",
                avatar_url: "https://avatars.example/acme.png",
              },
            },
          ],
        })
      }
      if (url.pathname === "/user/installations/44/repositories") {
        return Response.json({
          repositories: [
            {
              id: 202,
              name: "private-core",
              full_name: "acme/private-core",
              private: true,
              default_branch: "main",
              html_url: "https://github.com/acme/private-core",
              permissions: { pull: true, push: true },
            },
            {
              id: 101,
              name: "observatory",
              full_name: "acme/observatory",
              private: true,
              default_branch: "trunk",
              html_url: "https://github.com/acme/observatory",
              permissions: { pull: true },
            },
          ],
        })
      }
      return new Response("Not Found", { status: 404 })
    }
    const directory = new GitHubProjectDirectory({ fetch, apiOrigin: "https://api.example/" })

    const entries = await directory.list({ bearerToken: "short-lived-user-token" })

    expect(entries).toEqual([
      {
        provider: "github",
        installationId: "44",
        account: {
          id: "7",
          login: "acme",
          type: "organization",
          avatarUrl: "https://avatars.example/acme.png",
        },
        repository: {
          id: "101",
          name: "observatory",
          fullName: "acme/observatory",
          private: true,
          defaultBranch: "trunk",
          webUrl: "https://github.com/acme/observatory",
        },
        access: "watch",
      },
      {
        provider: "github",
        installationId: "44",
        account: {
          id: "7",
          login: "acme",
          type: "organization",
          avatarUrl: "https://avatars.example/acme.png",
        },
        repository: {
          id: "202",
          name: "private-core",
          fullName: "acme/private-core",
          private: true,
          defaultBranch: "main",
          webUrl: "https://github.com/acme/private-core",
        },
        access: "participate",
      },
    ])
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBe("Bearer short-lived-user-token")
      expect(request.headers.get("X-GitHub-Api-Version")).toBe("2022-11-28")
    }
  })

  test("follows only same-origin GitHub pagination", async () => {
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname === "/user/installations" && url.searchParams.get("page") === null) {
        return Response.json(
          { installations: [] },
          { headers: { Link: '<https://api.example/user/installations?page=2>; rel="next"' } },
        )
      }
      if (url.pathname === "/user/installations" && url.searchParams.get("page") === "2") {
        return Response.json({ installations: [] })
      }
      return new Response("Not Found", { status: 404 })
    }
    const directory = new GitHubProjectDirectory({ fetch, apiOrigin: "https://api.example/" })
    expect(await directory.list({ bearerToken: "token" })).toEqual([])
  })

  test("keeps the credential out of normalized provider failures", async () => {
    const token = "never-print-this-token"
    const directory = new GitHubProjectDirectory({
      apiOrigin: "https://api.example/",
      fetch: async () => new Response("denied", { status: 401 }),
    })

    try {
      await directory.list({ bearerToken: token })
      throw new Error("Expected GitHubProjectDirectory to reject")
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryDirectoryError)
      expect((error as Error).message).not.toContain(token)
      expect(error).toMatchObject({ provider: "github", status: 401, retryable: false })
    }
  })
})
