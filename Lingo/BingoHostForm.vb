Imports System.IO
Imports System.Linq
Imports System.Text

Partial Public Class BingoHostForm
    Private ReadOnly hostForm As Form1
    Private ReadOnly firestore As New BingoFirestoreService()
    Private ReadOnly caller As New BingoCaller()
    Private ReadOnly generatedCards As New List(Of BingoCard)

    Public Sub New(mainForm As Form1)
        InitializeComponent()
        hostForm = mainForm
    End Sub

    Private Sub BingoHostForm_Load(sender As Object, e As EventArgs) Handles MyBase.Load
        If String.IsNullOrEmpty(firestore.CurrentGameId) Then
            StartNewGame()
        End If
    End Sub

    Private Sub StartNewGame()
        caller.Reset()
        generatedCards.Clear()
        lstCalled.Items.Clear()
        lstCards.Items.Clear()
        lblLastCall.Text = "—"

        Dim gameId = firestore.StartNewGame()
        txtGameId.Text = gameId
        txtWebUrl.Text = firestore.WebUrlForGame(gameId)
        hostForm.SetBingoOverlay(Nothing, New List(Of String)())
    End Sub

    Private Sub btnNewGame_Click(sender As Object, e As EventArgs) Handles btnNewGame.Click
        If MessageBox.Show("Start a new bingo game? Existing called numbers will reset.", "New bingo game", MessageBoxButtons.YesNo) = DialogResult.Yes Then
            StartNewGame()
        End If
    End Sub

    Private Sub btnGeneratePlayers_Click(sender As Object, e As EventArgs) Handles btnGeneratePlayers.Click
        If String.IsNullOrEmpty(txtGameId.Text) Then
            MessageBox.Show("Start a game first.")
            Return
        End If
        For Each p As Player In hostForm.players
            GenerateCardForPlayer(p.Name)
        Next
        MessageBox.Show("Generated " + generatedCards.Count.ToString() + " card(s). Players open the URL to play.")
    End Sub

    Private Sub btnGenerateOne_Click(sender As Object, e As EventArgs) Handles btnGenerateOne.Click
        Dim name = txtPlayerName.Text.Trim()
        If String.IsNullOrEmpty(name) Then
            MessageBox.Show("Enter a display / Twitch name.")
            Return
        End If
        GenerateCardForPlayer(name)
    End Sub

    Private Sub GenerateCardForPlayer(displayName As String)
        If String.IsNullOrEmpty(txtGameId.Text) Then Return
        Dim seed = (txtGameId.Text + displayName).GetHashCode()
        Dim card = BingoCard.Generate(txtGameId.Text, displayName, seed)
        firestore.SaveCard(card)
        generatedCards.RemoveAll(Function(c) String.Equals(c.DisplayName, displayName, StringComparison.OrdinalIgnoreCase))
        generatedCards.Add(card)
        RefreshCardList()
    End Sub

    Private Sub RefreshCardList()
        lstCards.Items.Clear()
        For Each card In generatedCards.OrderBy(Function(c) c.DisplayName)
            lstCards.Items.Add(card.DisplayName)
        Next
    End Sub

    Private Sub btnCallNext_Click(sender As Object, e As EventArgs) Handles btnCallNext.Click
        CallNextBall()
    End Sub

    Private Sub CallNextBall()
        If String.IsNullOrEmpty(txtGameId.Text) Then Return
        Dim bingoCall = caller.CallNext()
        If bingoCall Is Nothing Then
            MessageBox.Show("All 75 balls have been called.")
            chkAutoCall.Checked = False
            Return
        End If

        firestore.PublishCall(txtGameId.Text, bingoCall)
        lblLastCall.Text = bingoCall.Label
        lstCalled.Items.Insert(0, bingoCall.Label)

        Dim history = caller.CalledHistory.Select(Function(c) c.Label).Reverse().Take(12).Reverse().ToList()
        hostForm.SetBingoOverlay(bingoCall.Label, history)
        AnnounceCallInChat(bingoCall.Label)
    End Sub

    Private Sub AnnounceCallInChat(label As String)
        Try
            If hostForm.client IsNot Nothing AndAlso hostForm.client.JoinedChannels.Count > 0 Then
                hostForm.client.SendMessage(hostForm.client.JoinedChannels(0), "Bingo call: " + label + " — Mark your card at " + BingoFeature.WebBaseUrl)
            End If
        Catch
        End Try
    End Sub

    Private Sub btnResetCaller_Click(sender As Object, e As EventArgs) Handles btnResetCaller.Click
        If MessageBox.Show("Reset the ball cage only? (keeps same game ID and player cards)", "Reset caller", MessageBoxButtons.YesNo) = DialogResult.Yes Then
            caller.Reset()
            lstCalled.Items.Clear()
            lblLastCall.Text = "—"
            hostForm.SetBingoOverlay(Nothing, New List(Of String)())
        End If
    End Sub

    Private Sub chkAutoCall_CheckedChanged(sender As Object, e As EventArgs) Handles chkAutoCall.CheckedChanged
        autoCallTimer.Enabled = chkAutoCall.Checked
        If chkAutoCall.Checked Then
            autoCallTimer.Interval = CInt(numAutoSeconds.Value) * 1000
        End If
    End Sub

    Private Sub numAutoSeconds_ValueChanged(sender As Object, e As EventArgs) Handles numAutoSeconds.ValueChanged
        autoCallTimer.Interval = CInt(numAutoSeconds.Value) * 1000
    End Sub

    Private Sub autoCallTimer_Tick(sender As Object, e As EventArgs) Handles autoCallTimer.Tick
        CallNextBall()
    End Sub

    Private Sub btnCopyUrl_Click(sender As Object, e As EventArgs) Handles btnCopyUrl.Click
        If Not String.IsNullOrEmpty(txtWebUrl.Text) Then
            Clipboard.SetText(txtWebUrl.Text)
            MessageBox.Show("Copied player URL to clipboard.")
        End If
    End Sub

    Private Sub btnExportHtml_Click(sender As Object, e As EventArgs) Handles btnExportHtml.Click
        If generatedCards.Count = 0 Then
            MessageBox.Show("Generate cards first.")
            Return
        End If
        Using dialog As New FolderBrowserDialog()
            dialog.Description = "Choose folder for printable bingo cards"
            If dialog.ShowDialog() <> DialogResult.OK Then Return

            Dim folder = Path.Combine(dialog.SelectedPath, "bingo_cards_" + txtGameId.Text.Substring(0, Math.Min(8, txtGameId.Text.Length)))
            Directory.CreateDirectory(folder)

            Dim indexHtml As New StringBuilder()
            indexHtml.AppendLine("<!DOCTYPE html><html><head><meta charset=""utf-8""><title>Bingo cards</title>")
            indexHtml.AppendLine("<style>body{font-family:Arial,sans-serif;background:#111;color:#fff;padding:20px;}")
            indexHtml.AppendLine(".bingo-card{display:inline-block;margin:16px;padding:12px;background:#0d6efd;border-radius:12px;vertical-align:top;}")
            indexHtml.AppendLine("table{border-collapse:collapse;} th,td{border:2px solid #fff;width:48px;height:48px;text-align:center;font-weight:bold;font-size:18px;}")
            indexHtml.AppendLine("h3{margin:0 0 8px;text-align:center;}</style></head><body>")
            indexHtml.AppendLine("<h1>Bingo cards — " + System.Net.WebUtility.HtmlEncode(txtGameId.Text) + "</h1>")

            For Each card In generatedCards
                Dim fileName = BingoFirestoreService.CardDocumentId(txtGameId.Text, card.DisplayName) + ".html"
                Dim cardHtml = "<!DOCTYPE html><html><head><meta charset=""utf-8""><title>" + System.Net.WebUtility.HtmlEncode(card.DisplayName) + "</title>" +
                    "<style>body{font-family:Arial;text-align:center;} table{margin:auto;border-collapse:collapse;} th,td{border:2px solid #333;width:56px;height:56px;font-size:20px;font-weight:bold;}</style></head><body>" +
                    card.ToPrintableHtml() + "</body></html>"
                File.WriteAllText(Path.Combine(folder, fileName), cardHtml)
                indexHtml.AppendLine(card.ToPrintableHtml())
            Next

            indexHtml.AppendLine("</body></html>")
            File.WriteAllText(Path.Combine(folder, "index.html"), indexHtml.ToString())
            MessageBox.Show("Saved to " + folder)
        End Using
    End Sub

    Private Sub btnAnnounceChat_Click(sender As Object, e As EventArgs) Handles btnAnnounceChat.Click
        Try
            If hostForm.client IsNot Nothing AndAlso hostForm.client.JoinedChannels.Count > 0 Then
                hostForm.client.SendMessage(hostForm.client.JoinedChannels(0),
                    "Endgame BINGO! Get your card and play at " + txtWebUrl.Text + " — use your exact Twitch username.")
            End If
        Catch ex As Exception
            MessageBox.Show("Could not send chat message: " + ex.Message)
        End Try
    End Sub

    Private Sub BingoHostForm_FormClosing(sender As Object, e As FormClosingEventArgs) Handles MyBase.FormClosing
        autoCallTimer.Enabled = False
        hostForm.ClearBingoOverlay()
    End Sub
End Class
