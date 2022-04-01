# NPM release

1. Bump version:
    ```bash
    yarn version --patch
    ```

2. Push changes and tags:
    ```bash
    git push --follow-tags
    ```
   
3. [Wait for tag pipeline to become green](https://github.com/buffcode/ntp-packet-parser/actions)

4. [Create a new release on GitHub](https://github.com/buffcode/ntp-packet-parser/releases/new)
    - Choose the tag from step 1/2
    - Title is `v{version}`
    - Give some description on what changed
